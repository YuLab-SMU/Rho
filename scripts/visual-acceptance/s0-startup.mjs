// S0: cold start, project open, and the first-view Navigator file tree.

import {
  assertEqual,
  assertIncludes,
  openProject,
  openSurface,
  waitUntil,
  waitReady,
  waitRuntimeReady,
} from "./helpers.mjs";

function requiredGeometry(records, label) {
  const geometry = records[0]?.geometry;
  if (geometry == null || geometry.rect == null) {
    throw new Error(`${label} geometry was not available`);
  }
  return geometry;
}

function assertNoHorizontalOverflow(geometry, label) {
  if (geometry.scroll_width > geometry.client_width + 1) {
    throw new Error(
      `${label} overflows horizontally (${geometry.scroll_width} > ${geometry.client_width} + 1)`,
    );
  }
}

function assertNoVerticalOverflow(geometry, label) {
  if (geometry.scroll_height > geometry.client_height + 1) {
    throw new Error(
      `${label} overflows vertically (${geometry.scroll_height} > ${geometry.client_height} + 1)`,
    );
  }
}

function assertContainedTextOverflow(geometry, label) {
  if (geometry.scroll_width <= geometry.client_width + 1) return;
  const overflowX = geometry.computed?.overflow_x ?? "";
  const textOverflow = geometry.computed?.text_overflow ?? "";
  if (!["hidden", "clip"].includes(overflowX)) {
    throw new Error(
      `${label} has visible horizontal content overflow ` +
      `(${geometry.scroll_width} > ${geometry.client_width} + 1; ` +
      `overflow-x=${JSON.stringify(overflowX)}, text-overflow=${JSON.stringify(textOverflow)})`,
    );
  }
}

function rectsIntersect(left, right) {
  const tolerance = 0.5;
  return left.left < right.right - tolerance &&
    left.right > right.left + tolerance &&
    left.top < right.bottom - tolerance &&
    left.bottom > right.top + tolerance;
}

function assertRectContained(inner, outer, label) {
  const tolerance = 1;
  if (
    inner.left < outer.left - tolerance ||
    inner.right > outer.right + tolerance ||
    inner.top < outer.top - tolerance ||
    inner.bottom > outer.bottom + tolerance
  ) {
    throw new Error(
      `${label} is clipped outside its container ` +
      `(element=${JSON.stringify(inner)}, container=${JSON.stringify(outer)})`,
    );
  }
}

export function compensatedWindowSize(requested, observed, target) {
  const width = Math.max(1, Math.min(16_384, Math.round(
    requested.width + target.width - observed.client_width,
  )));
  const height = Math.max(1, Math.min(16_384, Math.round(
    requested.height + target.height - observed.client_height,
  )));
  return { width, height };
}

async function settleViewport(ctx, width, height) {
  const deadline = Date.now() + 5_000;
  let latest = null;
  let requested = { width, height };
  while (Date.now() < deadline) {
    await ctx.setWindow(requested.width, requested.height);
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = requiredGeometry(await ctx.query("html", { geometry: true }), "HTML document");
    if (Math.abs(latest.client_width - width) <= 1 && Math.abs(latest.client_height - height) <= 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const confirmed = requiredGeometry(await ctx.query("html", { geometry: true }), "HTML document");
      if (
        Math.abs(confirmed.client_width - width) <= 1 &&
        Math.abs(confirmed.client_height - height) <= 1
      ) {
        return confirmed;
      }
      latest = confirmed;
    }
    requested = compensatedWindowSize(requested, latest, { width, height });
  }
  throw new Error(
    `application viewport did not settle at ${width}x${height}; ` +
    `last observed ${latest?.client_width ?? "unknown"}x${latest?.client_height ?? "unknown"}; ` +
    `last outer request ${requested.width}x${requested.height}`,
  );
}

export function validateAgentComposerGeometry({
  page,
  expectedViewport,
  surface,
  composer,
  controls,
  textarea,
  elements,
}) {
  const html = page["HTML document"];
  if (
    Math.abs(html.client_width - expectedViewport.width) > 1 ||
    Math.abs(html.client_height - expectedViewport.height) > 1
  ) {
    throw new Error(
      `HTML viewport is ${html.client_width}x${html.client_height}, ` +
      `expected ${expectedViewport.width}x${expectedViewport.height}`,
    );
  }
  for (const [label, geometry] of Object.entries(page)) {
    assertNoHorizontalOverflow(geometry, label);
  }
  assertNoHorizontalOverflow(surface, "Agent surface");
  assertNoHorizontalOverflow(composer, "Agent composer");
  assertNoHorizontalOverflow(controls, "Agent composer controls");

  const visibleElements = elements.filter(
    ({ geometry }) => geometry?.rect != null && geometry.rect.width > 0 && geometry.rect.height > 0,
  );
  if (visibleElements.length < 2) {
    throw new Error(`Agent composer exposed only ${visibleElements.length} measurable leaf controls`);
  }
  for (const [index, element] of visibleElements.entries()) {
    assertContainedTextOverflow(element.geometry, `Agent composer element ${index + 1} ${JSON.stringify(element.text)}`);
  }

  const textareaWidth = textarea.rect.width;
  const minimumTextareaWidth = Math.max(96, composer.client_width * 0.55);
  if (textareaWidth < minimumTextareaWidth) {
    throw new Error(
      `Agent composer textarea is too narrow for ordinary wrapped input ` +
      `(${textareaWidth} < ${minimumTextareaWidth})`,
    );
  }
  if (textareaWidth < textarea.rect.height) {
    throw new Error(
      `Agent composer textarea collapsed into a narrow column ` +
      `(${textareaWidth} wide by ${textarea.rect.height} high)`,
    );
  }

  for (let leftIndex = 0; leftIndex < visibleElements.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < visibleElements.length; rightIndex += 1) {
      const left = visibleElements[leftIndex];
      const right = visibleElements[rightIndex];
      if (rectsIntersect(left.geometry.rect, right.geometry.rect)) {
        throw new Error(
          `Agent composer controls overlap: ${JSON.stringify(left.text)} and ${JSON.stringify(right.text)}`,
        );
      }
    }
  }
  return {
    measurableControls: visibleElements.length,
    textareaWidth,
    minimumTextareaWidth,
    elements: visibleElements.map(({ text, geometry }) => ({
      text,
      client_width: geometry.client_width,
      scroll_width: geometry.scroll_width,
      overflow_x: geometry.computed?.overflow_x ?? "",
      text_overflow: geometry.computed?.text_overflow ?? "",
      rect: geometry.rect,
    })),
  };
}

export function validateNavigatorControlsGeometry({
  surface,
  header,
  navigator,
  controls,
  tabs,
  tabButtons,
  searchButton,
}) {
  assertNoHorizontalOverflow(surface, "Navigator Surface article");
  assertNoHorizontalOverflow(header, "Navigator Surface header");
  assertNoHorizontalOverflow(navigator, "Navigator");
  assertNoHorizontalOverflow(controls, "Navigator controls");
  assertNoVerticalOverflow(controls, "Navigator controls");
  assertNoHorizontalOverflow(tabs, "Navigator tablist");
  assertNoVerticalOverflow(tabs, "Navigator tablist");
  if (header.rect.bottom > surface.rect.top + 2
      || header.rect.left < surface.rect.left - 2
      || header.rect.right > surface.rect.right + 2) {
    throw new Error("Navigator Dockview title bar is not aligned immediately above its Surface content");
  }
  assertRectContained(navigator.rect, surface.rect, "Navigator section");
  assertRectContained(controls.rect, navigator.rect, "Navigator controls");
  assertRectContained(tabs.rect, controls.rect, "Navigator tablist");

  const expectedTabs = ["Files", "History"];
  if (
    tabButtons.length !== expectedTabs.length ||
    tabButtons.some((button, index) => button.label !== expectedTabs[index])
  ) {
    throw new Error(
      `Navigator exposed unexpected primary tabs ${JSON.stringify(tabButtons.map((button) => button.label))}`,
    );
  }
  if (searchButton?.label !== "Search project files") {
    throw new Error(`Navigator Files search trigger is unavailable (${JSON.stringify(searchButton?.label ?? null)})`);
  }

  const elements = [...tabButtons, searchButton];
  for (const element of elements) {
    const geometry = element.geometry;
    if (geometry?.rect == null || geometry.rect.width <= 0 || geometry.rect.height <= 0) {
      throw new Error(`Navigator control ${JSON.stringify(element.label)} has no reachable rectangle`);
    }
    if (geometry.rect.width < 27.5 || geometry.rect.height < 27.5) {
      throw new Error(
        `Navigator control ${JSON.stringify(element.label)} is smaller than the 28px token target ` +
        `(${geometry.rect.width}x${geometry.rect.height})`,
      );
    }
    assertNoHorizontalOverflow(geometry, `Navigator control ${JSON.stringify(element.label)}`);
    assertNoVerticalOverflow(geometry, `Navigator control ${JSON.stringify(element.label)}`);
    assertRectContained(geometry.rect, controls.rect, `Navigator control ${JSON.stringify(element.label)}`);
    assertRectContained(geometry.rect, navigator.rect, `Navigator control ${JSON.stringify(element.label)}`);
  }

  for (let leftIndex = 0; leftIndex < elements.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < elements.length; rightIndex += 1) {
      const left = elements[leftIndex];
      const right = elements[rightIndex];
      if (rectsIntersect(left.geometry.rect, right.geometry.rect)) {
        throw new Error(
          `Navigator controls overlap: ${JSON.stringify(left.label)} and ${JSON.stringify(right.label)}`,
        );
      }
    }
  }

  return {
    controls: elements.map(({ label, geometry }) => ({
      label,
      client_width: geometry.client_width,
      scroll_width: geometry.scroll_width,
      rect: geometry.rect,
    })),
    tablist: {
      client_width: tabs.client_width,
      client_height: tabs.client_height,
      scroll_width: tabs.scroll_width,
      scroll_height: tabs.scroll_height,
      rect: tabs.rect,
    },
    shell: {
      surface: surface.rect,
      header: header.rect,
      navigator: navigator.rect,
      controls: controls.rect,
    },
  };
}

export default async function s0(ctx) {
  await ctx.gate("s0", "app-ready", async () => {
    // The exact executable is born at the repository-standard 1440×900
    // geometry; the acknowledgement makes that cold-start behavior explicit
    // in the evidence without treating the post-ready Workbench as a startup
    // shell visual frame.
    await ctx.setWindow(1440, 900);
    const ready = await waitReady(ctx);
    return {
      startup: "cold",
      viewport: { width: 1440, height: 900 },
      kernelStatus: ready.kernelStatus,
      activeMode: ready.activeMode,
      restoredProject: ready.projectPath,
    };
  });

  await ctx.gate("s0", "project-open", async () => {
    const ready = await openProject(ctx, ctx.fixtures.workingProject);
    assertIncludes(ready.projectPath ?? "", "working-project", "ready().projectPath");
    // A Workspace R runtime must come up for the opened project; later
    // scenarios depend on this being reachable right after project open.
    const snapshot = await waitRuntimeReady(ctx);
    return {
      projectPath: ready.projectPath,
      kernelStatus: ready.kernelStatus,
      runtimes: snapshot.runtimes,
    };
  });

  // Keep the exact-app cold/warm behavior pair ahead of independent browser
  // and Navigator visual checks, so an unrelated frame or file-tree failure
  // cannot erase the warm-restart evidence.
  await ctx.gate("s0", "warm-restart-ready", async () => {
    await ctx.restart({ width: 1024, height: 680 });
    const ready = await waitReady(ctx);
    const viewport = await settleViewport(ctx, 1024, 680);
    assertIncludes(ready.projectPath ?? "", "working-project", "warm ready().projectPath");
    const snapshot = await waitRuntimeReady(ctx);
    return {
      startup: "warm",
      viewport: {
        width: viewport.client_width,
        height: viewport.client_height,
      },
      projectPath: ready.projectPath,
      kernelStatus: ready.kernelStatus,
      runtimes: snapshot.runtimes,
    };
  });

  // These are the deterministic active-stage visual frames. They use held
  // browser/mock command boundaries and are recorded separately from the real
  // debug application's post-ready behavior evidence.
  await ctx.captureStartupBrowserFrames();

  await ctx.gate("s0", "navigator-file-tree", async () => {
    await settleViewport(ctx, 1024, 680);
    await openSurface(ctx, "rho.navigator");
    const files = await ctx.query('[data-surface-id="rho.navigator"] [data-nav-file]', {
      all: true,
      attribute: "data-nav-file",
    });
    const paths = files.map((file) => file.value ?? "");
    assertIncludes(paths.join("\n"), "examples/rho-workbench-tour.R", "Navigator file tree");
    assertIncludes(paths.join("\n"), "reports/cell-qc-report.Rmd", "Navigator file tree");
    const statusbar = await ctx.query(".rho-statusbar");
    assertIncludes(statusbar[0]?.text ?? "", "working-project", "status bar project path");
    const navigatorSurface = requiredGeometry(
      await ctx.query('[data-surface-id="rho.navigator"]', { geometry: true }),
      "Navigator Surface article",
    );
    const navigatorHeader = requiredGeometry(
      await ctx.query('.dv-tabs-and-actions-container:has([data-rho-tab-instance-id="instance:navigator"])', { geometry: true }),
      "Navigator Dockview title bar",
    );
    const navigator = requiredGeometry(
      await ctx.query('.rho-navigator', { geometry: true }),
      "Navigator",
    );
    const navigatorControls = requiredGeometry(
      await ctx.query('.rho-navigator-controls', { geometry: true }),
      "Navigator controls",
    );
    const navigatorTabs = requiredGeometry(
      await ctx.query('.rho-navigator-tabs', { geometry: true }),
      "Navigator tablist",
    );
    const navigatorTabRecords = await ctx.query('.rho-navigator-tabs [role="tab"]', {
      all: true,
      geometry: true,
    });
    const navigatorSearchRecords = await ctx.query('.rho-navigator-search-toggle', {
      all: true,
      attribute: "aria-label",
      geometry: true,
    });
    const navigatorValidation = validateNavigatorControlsGeometry({
      surface: navigatorSurface,
      header: navigatorHeader,
      navigator,
      controls: navigatorControls,
      tabs: navigatorTabs,
      tabButtons: navigatorTabRecords.map((record) => ({
        label: record.text ?? "",
        geometry: record.geometry,
      })),
      searchButton: navigatorSearchRecords[0] == null ? null : {
        label: navigatorSearchRecords[0].value ?? "",
        geometry: navigatorSearchRecords[0].geometry,
      },
    });
    const navigatorControlsSelector = '[data-surface-id="rho.navigator"] .rho-navigator-controls';
    const navigatorTabSelector = (index) =>
      `[data-surface-id="rho.navigator"] .rho-navigator-tabs [role="tab"]:nth-child(${index})`;
    const focusedNavigatorControl = async (label, activeToken) => waitUntil(
      `Navigator keyboard focus ${label}`,
      async () => {
        const snapshot = await ctx.snapshot();
        if (!(snapshot.activeElement ?? "").includes(activeToken)) return null;
        const focused = await ctx.query(":focus", { geometry: true, attribute: "aria-label" });
        const geometry = focused[0]?.geometry;
        if (geometry?.rect == null) return null;
        if (geometry.rect.width < 27.5 || geometry.rect.height < 27.5) {
          throw new Error(`${label} focus target is below 28px (${geometry.rect.width}x${geometry.rect.height})`);
        }
        assertNoHorizontalOverflow(geometry, `${label} focused control`);
        assertRectContained(geometry.rect, navigatorControls.rect, `${label} focused control`);
        assertRectContained(geometry.rect, navigator.rect, `${label} focused control`);
        return {
          activeElement: snapshot.activeElement,
          label: focused[0]?.value ?? focused[0]?.text ?? label,
          geometry,
        };
      },
      { timeoutMs: 5_000, intervalMs: 100 },
    );

    await ctx.act({ kind: "click", selector: navigatorTabSelector(1) });
    const filesFocus = await focusedNavigatorControl("Files", "-files");
    await ctx.act({ kind: "key", key: "ArrowRight" });
    const historyFocus = await focusedNavigatorControl("History", "-runs");
    assertEqual(
      (await ctx.query(navigatorTabSelector(2), { attribute: "aria-selected" }))[0]?.value,
      "true",
      "Navigator History selection after ArrowRight",
    );
    await ctx.act({ kind: "key", key: "End" });
    const historyEndFocus = await focusedNavigatorControl("History after End", "-runs");
    assertEqual(
      (await ctx.query(navigatorTabSelector(2), { attribute: "aria-selected" }))[0]?.value,
      "true",
      "Navigator History selection after End",
    );
    await ctx.act({ kind: "key", key: "Home" });
    const restoredFilesFocus = await focusedNavigatorControl("Files", "-files");
    assertEqual(
      (await ctx.query(navigatorTabSelector(1), { attribute: "aria-selected" }))[0]?.value,
      "true",
      "Navigator Files selection after Home",
    );
    await ctx.act({ kind: "key", key: "Tab" });
    const searchFocus = await focusedNavigatorControl("Files search", 'aria-label="Search project files"');
    await ctx.act({ kind: "key", key: "Enter" });
    const searchInputFocus = await waitUntil(
      "Navigator search input keyboard focus",
      async () => {
        const snapshot = await ctx.snapshot();
        if (!(snapshot.activeElement ?? "").includes('aria-label="Filter project files"')) return null;
        const focused = await ctx.query('[aria-label="Filter project files"]:focus', { geometry: true });
        const geometry = focused[0]?.geometry;
        if (geometry?.rect == null) return null;
        if (geometry.rect.width < 27.5 || geometry.rect.height < 27.5) {
          throw new Error(
            `Navigator search input is below 28px (${geometry.rect.width}x${geometry.rect.height})`,
          );
        }
        assertNoHorizontalOverflow(geometry, "Navigator search input");
        assertRectContained(geometry.rect, navigator.rect, "Navigator search input");
        return { activeElement: snapshot.activeElement, geometry };
      },
      { timeoutMs: 5_000, intervalMs: 100 },
    );
    await ctx.act({ kind: "key", key: "Escape" });
    const searchRecoveryFocus = await focusedNavigatorControl(
      "Files search recovery",
      'aria-label="Search project files"',
    );
    assertEqual(
      (await ctx.query('[aria-label="Filter project files"]', { all: true })).length,
      0,
      "Navigator search input removed after Escape",
    );
    assertEqual(
      (await ctx.query(navigatorControlsSelector, { geometry: true }))[0]?.geometry?.scroll_width,
      navigatorControls.client_width,
      "Navigator controls width after keyboard route",
    );
    const page = {
      "HTML document": requiredGeometry(await ctx.query("html", { geometry: true }), "HTML document"),
      "document body": requiredGeometry(await ctx.query("body", { geometry: true }), "document body"),
      "Studio shell": requiredGeometry(await ctx.query(".rho-studio-shell", { geometry: true }), "Studio shell"),
    };
    const agentSurface = requiredGeometry(
      await ctx.query('.rho-agent-surface', { geometry: true }),
      "Agent surface",
    );
    const composer = requiredGeometry(
      await ctx.query('.rho-agent-surface .rho-agent-composer', { geometry: true }),
      "Agent composer",
    );
    const controls = requiredGeometry(
      await ctx.query('.rho-agent-surface .rho-agent-composer-actions', { geometry: true }),
      "Agent composer controls",
    );
    const textarea = requiredGeometry(
      await ctx.query('.rho-agent-surface .rho-agent-composer textarea', { geometry: true }),
      "Agent composer textarea",
    );

    const controlRecords = await ctx.query([
      '.rho-agent-surface .rho-agent-composer textarea',
      '.rho-agent-surface .rho-agent-composer-actions > button',
      '.rho-agent-surface .rho-agent-composer-hint',
    ].join(", "), { all: true, geometry: true });
    const validation = validateAgentComposerGeometry({
      page,
      expectedViewport: { width: 1024, height: 680 },
      surface: agentSurface,
      composer,
      controls,
      textarea,
      elements: controlRecords.map((record) => ({ text: record.text ?? "", geometry: record.geometry })),
    });
    return {
      fileCount: paths.length,
      statusbar: statusbar[0]?.text ?? null,
      navigator: {
        surface: navigatorSurface,
        header: navigatorHeader,
        geometry: navigator,
        controls: navigatorControls,
        validation: navigatorValidation,
        keyboard: {
          files: filesFocus,
          history: historyFocus,
          historyEnd: historyEndFocus,
          restoredFiles: restoredFilesFocus,
          search: searchFocus,
          searchInput: searchInputFocus,
          searchRecovery: searchRecoveryFocus,
        },
      },
      agentComposer: {
        page,
        surface: agentSurface,
        composer,
        controls,
        mode,
        validation,
      },
    };
  }, {
    screenshot: "s0-first-view",
    criteria: [
      "Navigator 文件树层级清晰（examples/、reports/、.rho/ 等顶层目录可辨认，子项缩进正确）",
      "文件夹与文件的图标/字形和标签文本可读，无截断重叠",
      "底部状态栏显示 Workspace R 运行状态与当前项目路径",
      "Files、History 与文件搜索均在窄 Navigator 内完整可达、无裁切或重叠",
      "整体布局无页级横向滚动条，无元素互相遮挡；Navigator 与 Agent composer 关键控件通过真实 DOM 几何断言",
    ],
  });

}
