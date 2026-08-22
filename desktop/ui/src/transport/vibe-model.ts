import type {
  VibeBlock,
  VibeBlockContent,
  VibeGridPlacement,
  VibePage,
  VibePageExport,
  VibePageMutation,
  VibeSection,
  VibeSectionLayout,
} from "./types";

const MAX_SECTIONS = 64;
const MAX_BLOCKS = 256;
const MAX_LIVE_SURFACES = 24;
const GRID_COLUMNS = 12;

type MutableSection = {
  section_id: string;
  heading: string | null;
  layout: VibeSectionLayout;
  blocks: VibeBlock[];
};

type MutablePage = Omit<VibePage, "sections" | "focused_block_id" | "page_revision"> & {
  page_revision: number;
  sections: MutableSection[];
  focused_block_id: string | null;
};

function failure(message: string): never {
  throw new Error(`Vibe Page rejected: ${message}`);
}

function clonePage(page: VibePage): MutablePage {
  return structuredClone(page) as MutablePage;
}

function blockIds(page: VibePage): string[] {
  return page.sections.flatMap((section) => section.blocks.map((block) => block.block_id));
}

function validateLayout(section: VibeSection): void {
  if (section.layout.kind === "flow") return;
  const ids = new Set(section.blocks.map((block) => block.block_id));
  if (section.layout.placements.length !== ids.size) {
    failure("Grid requires exactly one placement for each ordered block.");
  }
  const occupied = new Set<string>();
  const placed = new Set<string>();
  for (const placement of section.layout.placements) {
    if (!ids.has(placement.block_id) || placed.has(placement.block_id)) {
      failure("Grid placement has a missing or duplicate block identity.");
    }
    if (
      placement.row_start < 1 ||
      placement.column_start < 1 ||
      placement.column_span < 1 ||
      placement.column_start + placement.column_span - 1 > GRID_COLUMNS
    ) failure("Grid placement is outside the 12-column canvas.");
    placed.add(placement.block_id);
    for (let column = placement.column_start; column < placement.column_start + placement.column_span; column += 1) {
      const cell = `${placement.row_start}:${column}`;
      if (occupied.has(cell)) failure("Grid placements overlap.");
      occupied.add(cell);
    }
  }
}

export function validateVibePage(page: VibePage): void {
  if (page.page_revision < 1 || page.sections.length > MAX_SECTIONS) {
    failure("Page revision or Section budget is invalid.");
  }
  const sectionIds = new Set<string>();
  const ids = new Set<string>();
  const live = new Set<string>();
  let count = 0;
  for (const section of page.sections) {
    if (sectionIds.has(section.section_id)) failure("Section identities must be unique.");
    sectionIds.add(section.section_id);
    validateLayout(section);
    for (const block of section.blocks) {
      count += 1;
      if (ids.has(block.block_id)) failure("Block identities must be unique.");
      ids.add(block.block_id);
      if (block.content.kind === "surface_ref" && block.content.live) {
        if (live.has(block.content.instance_id)) failure("One live Surface instance cannot mount twice.");
        live.add(block.content.instance_id);
      }
      if (block.content.kind === "rich_text") {
        if (block.content.document.blocks.length === 0) failure("Rich text needs one document block.");
        for (const richBlock of block.content.document.blocks) {
          if (richBlock.kind === "heading" && (richBlock.level < 1 || richBlock.level > 3)) {
            failure("Rich-text heading level is unsupported.");
          }
        }
      }
    }
  }
  if (count > MAX_BLOCKS || live.size > MAX_LIVE_SURFACES) failure("Page block or live Surface budget is exceeded.");
  if (page.focused_block_id != null && !ids.has(page.focused_block_id)) {
    failure("Focused block does not exist.");
  }
}

function section(page: MutablePage, sectionId: string): MutableSection {
  const found = page.sections.find((candidate) => candidate.section_id === sectionId);
  if (found == null) failure("Section was not found.");
  return found;
}

function removeBlock(page: MutablePage, blockId: string): VibeBlock {
  for (const candidate of page.sections) {
    const index = candidate.blocks.findIndex((block) => block.block_id === blockId);
    if (index < 0) continue;
    const [removed] = candidate.blocks.splice(index, 1);
    if (removed == null) failure("Block removal failed.");
    if (candidate.layout.kind === "grid") {
      candidate.layout = {
        kind: "grid",
        placements: candidate.layout.placements.filter((placement) => placement.block_id !== blockId),
      };
    }
    return removed;
  }
  failure("Block was not found.");
}

function insertPlacement(section: MutableSection, blockId: string, placement: VibeGridPlacement | null): void {
  if (section.layout.kind === "flow" && placement == null) return;
  if (section.layout.kind !== "grid" || placement == null || placement.block_id !== blockId) {
    failure("Flow omits placement and Grid requires an exact placement.");
  }
  section.layout = {
    kind: "grid",
    placements: [...section.layout.placements, placement],
  };
}

export function applyVibePageMutation(
  page: VibePage,
  expectedRevision: number,
  mutation: VibePageMutation,
): VibePage {
  if (page.page_revision !== expectedRevision) failure("Page revision is stale.");
  const next = clonePage(page);
  switch (mutation.kind) {
    case "replace_sections":
      next.sections = structuredClone(mutation.sections) as MutableSection[];
      next.focused_block_id = mutation.focused_block_id;
      break;
    case "set_focus":
      next.focused_block_id = mutation.block_id;
      break;
    case "update_block": {
      const ids = blockIds(next);
      const index = ids.indexOf(mutation.block_id);
      if (index < 0 || mutation.replacement.block_id !== mutation.block_id) failure("Block replacement identity changed.");
      for (const candidate of next.sections) {
        const local = candidate.blocks.findIndex((block) => block.block_id === mutation.block_id);
        if (local >= 0) candidate.blocks[local] = structuredClone(mutation.replacement);
      }
      break;
    }
    case "insert_section":
      if (mutation.index < 0 || mutation.index > next.sections.length) failure("Section insertion index is out of bounds.");
      next.sections.splice(mutation.index, 0, structuredClone(mutation.section) as MutableSection);
      break;
    case "remove_section": {
      const index = next.sections.findIndex((candidate) => candidate.section_id === mutation.section_id);
      if (index < 0) failure("Section was not found.");
      next.sections.splice(index, 1);
      if (next.focused_block_id != null && !blockIds(next).includes(next.focused_block_id)) next.focused_block_id = null;
      break;
    }
    case "insert_block": {
      const target = section(next, mutation.section_id);
      if (mutation.index < 0 || mutation.index > target.blocks.length) failure("Block insertion index is out of bounds.");
      insertPlacement(target, mutation.block.block_id, mutation.grid_placement);
      target.blocks.splice(mutation.index, 0, structuredClone(mutation.block));
      break;
    }
    case "move_block": {
      const moved = removeBlock(next, mutation.block_id);
      const target = section(next, mutation.target_section_id);
      if (mutation.target_index < 0 || mutation.target_index > target.blocks.length) failure("Block target index is out of bounds.");
      insertPlacement(target, moved.block_id, mutation.grid_placement);
      target.blocks.splice(mutation.target_index, 0, moved);
      break;
    }
    case "remove_block":
      removeBlock(next, mutation.block_id);
      if (next.focused_block_id === mutation.block_id) next.focused_block_id = null;
      break;
    case "set_section_layout":
      section(next, mutation.section_id).layout = structuredClone(mutation.layout);
      break;
  }
  next.page_revision += 1;
  validateVibePage(next);
  return next;
}

function textOf(content: VibeBlockContent): string {
  switch (content.kind) {
    case "rich_text":
      return content.document.blocks.map((block) => {
        const text = block.content.map((inline) => inline.text).join("");
        return block.kind === "heading" ? `${"#".repeat(block.level + 2)} ${text}` : text;
      }).join("\n\n");
    case "callout": return `> [${content.tone}] ${content.text}`;
    case "divider": return "---";
    case "file_excerpt": return `[File excerpt: ${content.resource.resource_id} lines ${content.start_line}-${content.end_line}]`;
    case "artifact_ref": return `[Artifact: ${content.label} · ${content.artifact_id}]`;
    case "finding_ref": return `[Finding: ${content.label} · ${content.finding_id}]`;
    case "task_ref": return `[Task: ${content.label} · ${content.task_id}]`;
    case "surface_ref": return `[Surface: ${content.instance_id} · live=${String(content.live)}]`;
    case "command_ref": return `[Command: ${content.label} · ${content.command_id}]`;
  }
}

export function exportVibePage(page: VibePage): VibePageExport {
  validateVibePage(page);
  const chunks = [`# ${page.label}`];
  for (const section of page.sections) {
    if (section.heading != null) chunks.push(`## ${section.heading}`);
    chunks.push(...section.blocks.map((block) => textOf(block.content)));
  }
  return {
    contract: "rho.ui.vibe-page.export.v1",
    project_id: page.project_id,
    page_id: page.page_id,
    page_revision: page.page_revision,
    label: page.label,
    markdown: `${chunks.join("\n\n")}\n`,
  };
}
