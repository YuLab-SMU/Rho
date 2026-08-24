use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{
    BlockId, CommandId, ContractError, PageId, ProjectId, ResourceBindingV1, SectionId,
    SurfaceInstanceId, Validate, encoded_json_len, ensure_revision, next_revision, validate_label,
    validate_unique,
};

pub const MAX_VIBE_PAGE_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_VIBE_SECTIONS: usize = 64;
pub const MAX_VIBE_BLOCKS: usize = 256;
pub const MAX_VIBE_LIVE_SURFACES: usize = 24;
pub const MAX_VIBE_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_VIBE_GRID_COLUMNS: u8 = 12;
pub const MAX_VIBE_GRID_ROWS: u16 = 256;
pub const MAX_VIBE_RICH_TEXT_NODES: usize = 512;
pub const MAX_VIBE_INLINE_MARKS: usize = 4;
pub const VIBE_PAGE_EXPORT_CONTRACT: &str = "rho.ui.vibe-page.export.v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum VibeCalloutToneV1 {
    Neutral,
    Info,
    Success,
    Warning,
    Danger,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VibeRichTextMarkV1 {
    Strong,
    Emphasis,
    Code,
    Link { href: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct VibeRichTextInlineV1 {
    pub text: String,
    pub marks: Vec<VibeRichTextMarkV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VibeRichTextBlockV1 {
    Paragraph {
        content: Vec<VibeRichTextInlineV1>,
    },
    Heading {
        level: u8,
        content: Vec<VibeRichTextInlineV1>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct VibeRichTextDocumentV1 {
    pub blocks: Vec<VibeRichTextBlockV1>,
}

impl VibeRichTextDocumentV1 {
    pub fn plain_text(text: impl Into<String>) -> Self {
        Self {
            blocks: vec![VibeRichTextBlockV1::Paragraph {
                content: vec![VibeRichTextInlineV1 {
                    text: text.into(),
                    marks: Vec::new(),
                }],
            }],
        }
    }

    fn validate(&self) -> Result<(), ContractError> {
        if self.blocks.is_empty() || self.blocks.len() > MAX_VIBE_RICH_TEXT_NODES {
            return Err(ContractError::InvalidValue {
                path: "vibe_rich_text.blocks".to_string(),
                reason: "rich text requires a bounded non-empty block list".to_string(),
            });
        }
        let mut nodes = self.blocks.len();
        let mut text_bytes = 0usize;
        for block in &self.blocks {
            let content = match block {
                VibeRichTextBlockV1::Paragraph { content } => content,
                VibeRichTextBlockV1::Heading { level, content } => {
                    if !(1..=3).contains(level) {
                        return Err(ContractError::InvalidValue {
                            path: "vibe_rich_text.heading.level".to_string(),
                            reason: "heading level must be 1, 2, or 3".to_string(),
                        });
                    }
                    content
                }
            };
            nodes = nodes.saturating_add(content.len());
            if nodes > MAX_VIBE_RICH_TEXT_NODES {
                return Err(ContractError::LimitExceeded {
                    path: "vibe_rich_text.nodes".to_string(),
                    limit: MAX_VIBE_RICH_TEXT_NODES,
                    actual: nodes,
                });
            }
            for inline in content {
                crate::validate_text(
                    &inline.text,
                    "vibe_rich_text.inline.text",
                    MAX_VIBE_TEXT_BYTES,
                    true,
                    false,
                )?;
                text_bytes = text_bytes.saturating_add(inline.text.len());
                if inline.marks.len() > MAX_VIBE_INLINE_MARKS {
                    return Err(ContractError::LimitExceeded {
                        path: "vibe_rich_text.inline.marks".to_string(),
                        limit: MAX_VIBE_INLINE_MARKS,
                        actual: inline.marks.len(),
                    });
                }
                let marks = inline.marks.iter().collect::<BTreeSet<_>>();
                if marks.len() != inline.marks.len() {
                    return Err(ContractError::Duplicate {
                        path: "vibe_rich_text.inline.marks".to_string(),
                        value: "duplicate mark".to_string(),
                    });
                }
                for mark in &inline.marks {
                    if let VibeRichTextMarkV1::Link { href } = mark {
                        crate::validate_text(
                            href,
                            "vibe_rich_text.link.href",
                            2_048,
                            false,
                            false,
                        )?;
                        if !(href.starts_with("https://") || href.starts_with('#')) {
                            return Err(ContractError::InvalidValue {
                                path: "vibe_rich_text.link.href".to_string(),
                                reason: "rich-text links must be HTTPS or local anchors"
                                    .to_string(),
                            });
                        }
                    }
                }
            }
        }
        if text_bytes > MAX_VIBE_TEXT_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "vibe_rich_text.text".to_string(),
                limit: MAX_VIBE_TEXT_BYTES,
                actual: text_bytes,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VibeBlockContentV1 {
    RichText {
        document: VibeRichTextDocumentV1,
    },
    Callout {
        tone: VibeCalloutToneV1,
        text: String,
    },
    Divider,
    FileExcerpt {
        resource: ResourceBindingV1,
        #[specta(type = crate::UiIpcNumber)]
        start_line: u64,
        #[specta(type = crate::UiIpcNumber)]
        end_line: u64,
    },
    ArtifactRef {
        artifact_id: String,
        label: String,
    },
    FindingRef {
        finding_id: String,
        label: String,
    },
    TaskRef {
        task_id: String,
        label: String,
    },
    SurfaceRef {
        instance_id: SurfaceInstanceId,
        live: bool,
    },
    CommandRef {
        command_id: CommandId,
        label: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct VibeBlockV1 {
    pub block_id: BlockId,
    pub content: VibeBlockContentV1,
}

impl Validate for VibeBlockV1 {
    fn validate(&self) -> Result<(), ContractError> {
        match &self.content {
            VibeBlockContentV1::RichText { document } => document.validate(),
            VibeBlockContentV1::Callout { text, .. } => {
                crate::validate_text(text, "vibe_block.text", MAX_VIBE_TEXT_BYTES, false, true)
            }
            VibeBlockContentV1::Divider | VibeBlockContentV1::SurfaceRef { .. } => Ok(()),
            VibeBlockContentV1::FileExcerpt {
                resource,
                start_line,
                end_line,
            } => {
                resource.validate()?;
                if start_line == &0 || start_line > end_line {
                    return Err(ContractError::InvalidValue {
                        path: "vibe_block.file_excerpt".to_string(),
                        reason: "line range must be positive and ordered".to_string(),
                    });
                }
                Ok(())
            }
            VibeBlockContentV1::ArtifactRef { artifact_id, label } => {
                crate::validate_opaque_text(artifact_id, "vibe_block.artifact_id")?;
                validate_label(label, "vibe_block.label")
            }
            VibeBlockContentV1::FindingRef { finding_id, label } => {
                crate::validate_opaque_text(finding_id, "vibe_block.finding_id")?;
                validate_label(label, "vibe_block.label")
            }
            VibeBlockContentV1::TaskRef { task_id, label } => {
                crate::validate_opaque_text(task_id, "vibe_block.task_id")?;
                validate_label(label, "vibe_block.label")
            }
            VibeBlockContentV1::CommandRef { label, .. } => {
                validate_label(label, "vibe_block.command_label")
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct VibeGridPlacementV1 {
    pub block_id: BlockId,
    pub row_start: u16,
    pub column_start: u8,
    pub column_span: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VibeSectionLayoutV1 {
    Flow,
    Grid {
        placements: Vec<VibeGridPlacementV1>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct VibeSectionV1 {
    pub section_id: SectionId,
    pub heading: Option<String>,
    pub layout: VibeSectionLayoutV1,
    pub blocks: Vec<VibeBlockV1>,
}

impl Validate for VibeSectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if let Some(heading) = &self.heading {
            validate_label(heading, "vibe_section.heading")?;
        }
        if self.blocks.len() > MAX_VIBE_BLOCKS {
            return Err(ContractError::LimitExceeded {
                path: "vibe_section.blocks".to_string(),
                limit: MAX_VIBE_BLOCKS,
                actual: self.blocks.len(),
            });
        }
        validate_unique(
            "vibe_section.blocks",
            self.blocks.iter().map(|block| block.block_id.as_ref()),
        )?;
        for block in &self.blocks {
            block.validate()?;
        }
        if let VibeSectionLayoutV1::Grid { placements } = &self.layout {
            validate_grid(&self.blocks, placements)?;
        }
        Ok(())
    }
}

fn validate_grid(
    blocks: &[VibeBlockV1],
    placements: &[VibeGridPlacementV1],
) -> Result<(), ContractError> {
    if placements.len() != blocks.len() {
        return Err(ContractError::InvalidValue {
            path: "vibe_section.layout.placements".to_string(),
            reason: "a Grid requires exactly one placement per block".to_string(),
        });
    }
    validate_unique(
        "vibe_section.layout.placements",
        placements
            .iter()
            .map(|placement| placement.block_id.as_ref()),
    )?;
    let block_ids = blocks
        .iter()
        .map(|block| block.block_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut occupied = BTreeSet::new();
    for placement in placements {
        if !block_ids.contains(placement.block_id.as_str()) {
            return Err(ContractError::MissingReference {
                path: "vibe_section.layout.placements.block_id".to_string(),
                value: placement.block_id.to_string(),
            });
        }
        if placement.row_start == 0 || placement.row_start > MAX_VIBE_GRID_ROWS {
            return Err(ContractError::InvalidValue {
                path: "vibe_section.layout.placements.row_start".to_string(),
                reason: format!("row must be 1..={MAX_VIBE_GRID_ROWS}"),
            });
        }
        if placement.column_start == 0
            || placement.column_span == 0
            || placement.column_start > MAX_VIBE_GRID_COLUMNS
            || placement.column_span > MAX_VIBE_GRID_COLUMNS
            || placement.column_start + placement.column_span - 1 > MAX_VIBE_GRID_COLUMNS
        {
            return Err(ContractError::InvalidValue {
                path: "vibe_section.layout.placements.columns".to_string(),
                reason: "column start/span must fit the 12-column grid".to_string(),
            });
        }
        for column in placement.column_start..placement.column_start + placement.column_span {
            if !occupied.insert((placement.row_start, column)) {
                return Err(ContractError::InvalidValue {
                    path: "vibe_section.layout.placements".to_string(),
                    reason: format!(
                        "grid cells overlap at row {}, column {}",
                        placement.row_start, column
                    ),
                });
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct VibePageV1 {
    pub page_id: PageId,
    pub project_id: ProjectId,
    pub label: String,
    #[specta(type = crate::UiIpcNumber)]
    pub page_revision: u64,
    pub sections: Vec<VibeSectionV1>,
    pub focused_block_id: Option<BlockId>,
}

impl Validate for VibePageV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.label, "vibe_page.label")?;
        if self.sections.len() > MAX_VIBE_SECTIONS {
            return Err(ContractError::LimitExceeded {
                path: "vibe_page.sections".to_string(),
                limit: MAX_VIBE_SECTIONS,
                actual: self.sections.len(),
            });
        }
        validate_unique(
            "vibe_page.sections",
            self.sections
                .iter()
                .map(|section| section.section_id.as_ref()),
        )?;
        let mut block_ids = BTreeSet::new();
        let mut live_instances = BTreeMap::new();
        let mut blocks = 0;
        let mut live_surfaces = 0;
        for section in &self.sections {
            section.validate()?;
            for block in &section.blocks {
                blocks += 1;
                if blocks > MAX_VIBE_BLOCKS {
                    return Err(ContractError::LimitExceeded {
                        path: "vibe_page.blocks".to_string(),
                        limit: MAX_VIBE_BLOCKS,
                        actual: blocks,
                    });
                }
                if !block_ids.insert(block.block_id.as_str()) {
                    return Err(ContractError::Duplicate {
                        path: "vibe_page.blocks".to_string(),
                        value: block.block_id.to_string(),
                    });
                }
                if let VibeBlockContentV1::SurfaceRef {
                    instance_id,
                    live: true,
                } = &block.content
                {
                    live_surfaces += 1;
                    if live_surfaces > MAX_VIBE_LIVE_SURFACES {
                        return Err(ContractError::LimitExceeded {
                            path: "vibe_page.live_surfaces".to_string(),
                            limit: MAX_VIBE_LIVE_SURFACES,
                            actual: live_surfaces,
                        });
                    }
                    if live_instances
                        .insert(instance_id.as_str(), block.block_id.as_str())
                        .is_some()
                    {
                        return Err(ContractError::Duplicate {
                            path: "vibe_page.live_surface_instances".to_string(),
                            value: instance_id.to_string(),
                        });
                    }
                }
            }
        }
        if let Some(focused) = &self.focused_block_id
            && !block_ids.contains(focused.as_str())
        {
            return Err(ContractError::MissingReference {
                path: "vibe_page.focused_block_id".to_string(),
                value: focused.to_string(),
            });
        }
        let encoded = encoded_json_len("vibe_page", self)?;
        if encoded > MAX_VIBE_PAGE_JSON_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "vibe_page.encoded_bytes".to_string(),
                limit: MAX_VIBE_PAGE_JSON_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VibePageMutationV1 {
    ReplaceSections {
        sections: Vec<VibeSectionV1>,
        focused_block_id: Option<BlockId>,
    },
    SetFocus {
        block_id: Option<BlockId>,
    },
    UpdateBlock {
        block_id: BlockId,
        replacement: VibeBlockV1,
    },
    InsertSection {
        #[specta(type = crate::UiIpcNumber)]
        index: usize,
        section: VibeSectionV1,
    },
    RemoveSection {
        section_id: SectionId,
    },
    InsertBlock {
        section_id: SectionId,
        #[specta(type = crate::UiIpcNumber)]
        index: usize,
        block: VibeBlockV1,
        grid_placement: Option<VibeGridPlacementV1>,
    },
    MoveBlock {
        block_id: BlockId,
        target_section_id: SectionId,
        #[specta(type = crate::UiIpcNumber)]
        target_index: usize,
        grid_placement: Option<VibeGridPlacementV1>,
    },
    RemoveBlock {
        block_id: BlockId,
    },
    SetSectionLayout {
        section_id: SectionId,
        layout: VibeSectionLayoutV1,
    },
}

pub fn apply_vibe_page_mutation(
    page: &VibePageV1,
    expected_revision: u64,
    mutation: VibePageMutationV1,
) -> Result<VibePageV1, ContractError> {
    ensure_revision(
        "vibe_page.page_revision",
        expected_revision,
        page.page_revision,
    )?;
    let mut next = page.clone();
    match mutation {
        VibePageMutationV1::ReplaceSections {
            sections,
            focused_block_id,
        } => {
            next.sections = sections;
            next.focused_block_id = focused_block_id;
        }
        VibePageMutationV1::SetFocus { block_id } => next.focused_block_id = block_id,
        VibePageMutationV1::UpdateBlock {
            block_id,
            replacement,
        } => {
            if replacement.block_id != block_id {
                return Err(ContractError::InvalidValue {
                    path: "vibe_page_mutation.replacement.block_id".to_string(),
                    reason: "replacement must retain the target block identity".to_string(),
                });
            }
            let mut found = false;
            for section in &mut next.sections {
                if let Some(block) = section
                    .blocks
                    .iter_mut()
                    .find(|block| block.block_id == block_id)
                {
                    *block = replacement.clone();
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(ContractError::MissingReference {
                    path: "vibe_page_mutation.block_id".to_string(),
                    value: block_id.to_string(),
                });
            }
        }
        VibePageMutationV1::InsertSection { index, section } => {
            if index > next.sections.len() {
                return Err(ContractError::InvalidValue {
                    path: "vibe_page_mutation.section_index".to_string(),
                    reason: "section insertion index is out of bounds".to_string(),
                });
            }
            next.sections.insert(index, section);
        }
        VibePageMutationV1::RemoveSection { section_id } => {
            let before = next.sections.len();
            next.sections
                .retain(|section| section.section_id != section_id);
            if before == next.sections.len() {
                return Err(ContractError::MissingReference {
                    path: "vibe_page_mutation.section_id".to_string(),
                    value: section_id.to_string(),
                });
            }
            next.focused_block_id = next.focused_block_id.clone().filter(|focused| {
                next.sections.iter().any(|section| {
                    section
                        .blocks
                        .iter()
                        .any(|block| block.block_id == *focused)
                })
            });
        }
        VibePageMutationV1::InsertBlock {
            section_id,
            index,
            block,
            grid_placement,
        } => {
            let section = section_mut(&mut next, &section_id)?;
            if index > section.blocks.len() {
                return Err(ContractError::InvalidValue {
                    path: "vibe_page_mutation.block_index".to_string(),
                    reason: "block insertion index is out of bounds".to_string(),
                });
            }
            reconcile_inserted_grid_placement(section, &block.block_id, grid_placement)?;
            section.blocks.insert(index, block);
        }
        VibePageMutationV1::MoveBlock {
            block_id,
            target_section_id,
            target_index,
            grid_placement,
        } => {
            let block = remove_block(&mut next, &block_id)?;
            let section = section_mut(&mut next, &target_section_id)?;
            if target_index > section.blocks.len() {
                return Err(ContractError::InvalidValue {
                    path: "vibe_page_mutation.target_index".to_string(),
                    reason: "block target index is out of bounds".to_string(),
                });
            }
            reconcile_inserted_grid_placement(section, &block.block_id, grid_placement)?;
            section.blocks.insert(target_index, block);
        }
        VibePageMutationV1::RemoveBlock { block_id } => {
            remove_block(&mut next, &block_id)?;
            if next.focused_block_id.as_ref() == Some(&block_id) {
                next.focused_block_id = None;
            }
        }
        VibePageMutationV1::SetSectionLayout { section_id, layout } => {
            section_mut(&mut next, &section_id)?.layout = layout;
        }
    }
    next.page_revision = next_revision("vibe_page.page_revision", expected_revision)?;
    next.validate()?;
    Ok(next)
}

fn section_mut<'a>(
    page: &'a mut VibePageV1,
    section_id: &SectionId,
) -> Result<&'a mut VibeSectionV1, ContractError> {
    page.sections
        .iter_mut()
        .find(|section| section.section_id == *section_id)
        .ok_or_else(|| ContractError::MissingReference {
            path: "vibe_page_mutation.section_id".to_string(),
            value: section_id.to_string(),
        })
}

fn remove_block(page: &mut VibePageV1, block_id: &BlockId) -> Result<VibeBlockV1, ContractError> {
    for section in &mut page.sections {
        if let Some(index) = section
            .blocks
            .iter()
            .position(|block| block.block_id == *block_id)
        {
            if let VibeSectionLayoutV1::Grid { placements } = &mut section.layout {
                placements.retain(|placement| placement.block_id != *block_id);
            }
            return Ok(section.blocks.remove(index));
        }
    }
    Err(ContractError::MissingReference {
        path: "vibe_page_mutation.block_id".to_string(),
        value: block_id.to_string(),
    })
}

fn reconcile_inserted_grid_placement(
    section: &mut VibeSectionV1,
    block_id: &BlockId,
    placement: Option<VibeGridPlacementV1>,
) -> Result<(), ContractError> {
    match (&mut section.layout, placement) {
        (VibeSectionLayoutV1::Flow, None) => Ok(()),
        (VibeSectionLayoutV1::Grid { placements }, Some(placement)) => {
            if placement.block_id != *block_id {
                return Err(ContractError::InvalidValue {
                    path: "vibe_page_mutation.grid_placement.block_id".to_string(),
                    reason: "grid placement must retain inserted block identity".to_string(),
                });
            }
            placements.push(placement);
            Ok(())
        }
        _ => Err(ContractError::InvalidValue {
            path: "vibe_page_mutation.grid_placement".to_string(),
            reason: "Flow blocks omit placement and Grid blocks require one".to_string(),
        }),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct VibePageExportV1 {
    pub contract: String,
    pub project_id: ProjectId,
    pub page_id: PageId,
    #[specta(type = crate::UiIpcNumber)]
    pub page_revision: u64,
    pub label: String,
    pub markdown: String,
}

pub fn export_vibe_page(page: &VibePageV1) -> Result<VibePageExportV1, ContractError> {
    page.validate()?;
    let mut markdown = format!("# {}\n", page.label);
    for section in &page.sections {
        if let Some(heading) = &section.heading {
            markdown.push_str(&format!("\n## {heading}\n"));
        }
        for block in &section.blocks {
            markdown.push('\n');
            markdown.push_str(&export_block(&block.content));
            markdown.push('\n');
        }
    }
    crate::validate_text(
        &markdown,
        "vibe_page_export.markdown",
        MAX_VIBE_PAGE_JSON_BYTES,
        false,
        true,
    )?;
    Ok(VibePageExportV1 {
        contract: VIBE_PAGE_EXPORT_CONTRACT.to_string(),
        project_id: page.project_id.clone(),
        page_id: page.page_id.clone(),
        page_revision: page.page_revision,
        label: page.label.clone(),
        markdown,
    })
}

fn export_block(content: &VibeBlockContentV1) -> String {
    match content {
        VibeBlockContentV1::RichText { document } => document
            .blocks
            .iter()
            .map(|block| match block {
                VibeRichTextBlockV1::Paragraph { content } => export_inlines(content),
                VibeRichTextBlockV1::Heading { level, content } => {
                    format!(
                        "{} {}",
                        "#".repeat(*level as usize + 2),
                        export_inlines(content)
                    )
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        VibeBlockContentV1::Callout { tone, text } => {
            let tone = match tone {
                VibeCalloutToneV1::Neutral => "neutral",
                VibeCalloutToneV1::Info => "info",
                VibeCalloutToneV1::Success => "success",
                VibeCalloutToneV1::Warning => "warning",
                VibeCalloutToneV1::Danger => "danger",
            };
            format!("> [{tone}] {text}")
        }
        VibeBlockContentV1::Divider => "---".to_string(),
        VibeBlockContentV1::FileExcerpt {
            resource,
            start_line,
            end_line,
        } => format!(
            "[File excerpt: {} lines {}-{}]",
            resource.resource_id, start_line, end_line
        ),
        VibeBlockContentV1::ArtifactRef { artifact_id, label } => {
            format!("[Artifact: {label} · {artifact_id}]")
        }
        VibeBlockContentV1::FindingRef { finding_id, label } => {
            format!("[Finding: {label} · {finding_id}]")
        }
        VibeBlockContentV1::TaskRef { task_id, label } => {
            format!("[Task: {label} · {task_id}]")
        }
        VibeBlockContentV1::SurfaceRef { instance_id, live } => {
            format!("[Surface: {instance_id} · live={live}]")
        }
        VibeBlockContentV1::CommandRef { command_id, label } => {
            format!("[Command: {label} · {command_id}]")
        }
    }
}

fn export_inlines(content: &[VibeRichTextInlineV1]) -> String {
    content
        .iter()
        .map(|inline| inline.text.as_str())
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: &str, text: &str) -> VibeBlockV1 {
        VibeBlockV1 {
            block_id: BlockId::new(id).unwrap(),
            content: VibeBlockContentV1::RichText {
                document: VibeRichTextDocumentV1::plain_text(text),
            },
        }
    }

    fn page() -> VibePageV1 {
        VibePageV1 {
            page_id: PageId::new("page:review").unwrap(),
            project_id: ProjectId::new("project:a").unwrap(),
            label: "Project review".to_string(),
            page_revision: 3,
            sections: vec![VibeSectionV1 {
                section_id: SectionId::new("section:summary").unwrap(),
                heading: Some("Summary".to_string()),
                layout: VibeSectionLayoutV1::Grid {
                    placements: vec![
                        VibeGridPlacementV1 {
                            block_id: BlockId::new("block:text").unwrap(),
                            row_start: 1,
                            column_start: 1,
                            column_span: 5,
                        },
                        VibeGridPlacementV1 {
                            block_id: BlockId::new("block:surface").unwrap(),
                            row_start: 1,
                            column_start: 6,
                            column_span: 7,
                        },
                    ],
                },
                blocks: vec![
                    block("block:text", "Review notes"),
                    VibeBlockV1 {
                        block_id: BlockId::new("block:surface").unwrap(),
                        content: VibeBlockContentV1::SurfaceRef {
                            instance_id: SurfaceInstanceId::new("instance:check").unwrap(),
                            live: true,
                        },
                    },
                ],
            }],
            focused_block_id: Some(BlockId::new("block:text").unwrap()),
        }
    }

    #[test]
    fn ordered_grid_page_is_valid() {
        page().validate().unwrap();
    }

    #[test]
    fn empty_vibe_page_and_empty_flow_section_are_valid_authoring_states() {
        let mut empty = page();
        empty.sections.clear();
        empty.focused_block_id = None;
        empty.validate().unwrap();

        empty.sections.push(VibeSectionV1 {
            section_id: SectionId::new("section:empty").unwrap(),
            heading: None,
            layout: VibeSectionLayoutV1::Flow,
            blocks: vec![],
        });
        empty.validate().unwrap();
    }

    #[test]
    fn overlapping_grid_cells_are_rejected() {
        let mut page = page();
        let VibeSectionLayoutV1::Grid { placements } = &mut page.sections[0].layout else {
            panic!("fixture grid")
        };
        placements[1].column_start = 5;
        assert!(page.validate().is_err());
    }

    #[test]
    fn same_live_instance_cannot_be_mounted_twice() {
        let mut page = page();
        let duplicate = VibeBlockV1 {
            block_id: BlockId::new("block:duplicate").unwrap(),
            content: VibeBlockContentV1::SurfaceRef {
                instance_id: SurfaceInstanceId::new("instance:check").unwrap(),
                live: true,
            },
        };
        page.sections.push(VibeSectionV1 {
            section_id: SectionId::new("section:duplicate").unwrap(),
            heading: None,
            layout: VibeSectionLayoutV1::Flow,
            blocks: vec![duplicate],
        });
        assert!(matches!(
            page.validate(),
            Err(ContractError::Duplicate { .. })
        ));
    }

    #[test]
    fn page_mutations_reject_stale_and_missing_targets() {
        let page = page();
        assert!(matches!(
            apply_vibe_page_mutation(&page, 2, VibePageMutationV1::SetFocus { block_id: None }),
            Err(ContractError::StaleRevision { .. })
        ));
        assert!(
            apply_vibe_page_mutation(
                &page,
                3,
                VibePageMutationV1::SetFocus {
                    block_id: Some(BlockId::new("block:missing").unwrap())
                }
            )
            .is_err()
        );
        assert_eq!(page.page_revision, 3);
    }

    #[test]
    fn page_byte_budget_uses_payload_shape_not_pathological_item_count() {
        let mut page = page();
        page.sections[0].blocks[0] = block("block:text", &"x".repeat(MAX_VIBE_TEXT_BYTES));
        page.validate().unwrap();
        page.sections[0].blocks[0] = block("block:text", &"x".repeat(MAX_VIBE_TEXT_BYTES + 1));
        assert!(page.validate().is_err());
    }

    #[test]
    fn page_encoded_byte_budget_rejects_large_but_individually_valid_blocks() {
        let mut page = page();
        let blocks = (0..17)
            .map(|index| {
                block(
                    &format!("block:large-{index}"),
                    &"x".repeat(MAX_VIBE_TEXT_BYTES),
                )
            })
            .collect::<Vec<_>>();
        page.sections = vec![VibeSectionV1 {
            section_id: SectionId::new("section:large").unwrap(),
            heading: None,
            layout: VibeSectionLayoutV1::Flow,
            blocks,
        }];
        page.focused_block_id = None;
        assert!(matches!(
            page.validate(),
            Err(ContractError::LimitExceeded { path, .. }) if path == "vibe_page.encoded_bytes"
        ));
    }

    #[test]
    fn insert_move_resize_and_remove_preserve_exact_order() {
        let page = page();
        let inserted = block("block:inserted", "Inserted");
        let page = apply_vibe_page_mutation(
            &page,
            3,
            VibePageMutationV1::InsertBlock {
                section_id: SectionId::new("section:summary").unwrap(),
                index: 1,
                block: inserted,
                grid_placement: Some(VibeGridPlacementV1 {
                    block_id: BlockId::new("block:inserted").unwrap(),
                    row_start: 2,
                    column_start: 1,
                    column_span: 12,
                }),
            },
        )
        .unwrap();
        assert_eq!(page.page_revision, 4);
        assert_eq!(
            page.sections[0].blocks[1].block_id.as_str(),
            "block:inserted"
        );

        let page = apply_vibe_page_mutation(
            &page,
            4,
            VibePageMutationV1::MoveBlock {
                block_id: BlockId::new("block:inserted").unwrap(),
                target_section_id: SectionId::new("section:summary").unwrap(),
                target_index: 0,
                grid_placement: Some(VibeGridPlacementV1 {
                    block_id: BlockId::new("block:inserted").unwrap(),
                    row_start: 2,
                    column_start: 1,
                    column_span: 6,
                }),
            },
        )
        .unwrap();
        assert_eq!(
            page.sections[0].blocks[0].block_id.as_str(),
            "block:inserted"
        );

        let page = apply_vibe_page_mutation(
            &page,
            5,
            VibePageMutationV1::RemoveBlock {
                block_id: BlockId::new("block:inserted").unwrap(),
            },
        )
        .unwrap();
        assert!(
            !page.sections[0]
                .blocks
                .iter()
                .any(|block| block.block_id.as_str() == "block:inserted")
        );
    }

    #[test]
    fn rejected_grid_candidate_leaves_original_unchanged() {
        let page = page();
        let result = apply_vibe_page_mutation(
            &page,
            3,
            VibePageMutationV1::InsertBlock {
                section_id: SectionId::new("section:summary").unwrap(),
                index: 1,
                block: block("block:overlap", "Overlap"),
                grid_placement: Some(VibeGridPlacementV1 {
                    block_id: BlockId::new("block:overlap").unwrap(),
                    row_start: 1,
                    column_start: 1,
                    column_span: 2,
                }),
            },
        );
        assert!(result.is_err());
        assert_eq!(page.page_revision, 3);
        assert_eq!(page.sections[0].blocks.len(), 2);
    }

    #[test]
    fn export_is_deterministic_and_contains_only_surface_placeholders() {
        let page = page();
        let first = export_vibe_page(&page).unwrap();
        let second = export_vibe_page(&page).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.contract, VIBE_PAGE_EXPORT_CONTRACT);
        assert!(first.markdown.contains("Review notes"));
        assert!(
            first
                .markdown
                .contains("[Surface: instance:check · live=true]")
        );
        assert!(!first.markdown.contains('<'));
    }

    #[test]
    fn rich_text_rejects_unsafe_links_and_excessive_nodes() {
        let mut page = page();
        page.sections[0].blocks[0].content = VibeBlockContentV1::RichText {
            document: VibeRichTextDocumentV1 {
                blocks: vec![VibeRichTextBlockV1::Paragraph {
                    content: vec![VibeRichTextInlineV1 {
                        text: "unsafe".to_string(),
                        marks: vec![VibeRichTextMarkV1::Link {
                            href: "javascript:alert(1)".to_string(),
                        }],
                    }],
                }],
            },
        };
        assert!(page.validate().is_err());
    }
}
