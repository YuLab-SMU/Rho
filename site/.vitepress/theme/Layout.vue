<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { computed } from 'vue';
import { useData } from 'vitepress';
import navigation from '../generated/navigation.json';

const { page } = useData();

// Every published page names the Markdown file it came from, so a reader can
// check the site against the repository instead of trusting the build.
const sources = new Map<string, string>();
for (const items of Object.values(
  (navigation as { sections: Record<string, { link: string; source?: string }[]> }).sections,
)) {
  for (const item of items) {
    if (item.source) sources.set(`${item.link.replace(/^\//, '')}.md`, item.source);
  }
}

const source = computed(() => sources.get(page.value.relativePath) ?? null);
const sourceUrl = computed(() =>
  source.value ? `https://github.com/YuLab-SMU/Rho/blob/main/${source.value}` : '',
);
</script>

<template>
  <DefaultTheme.Layout>
    <template #doc-footer-before>
      <p v-if="source" class="page-source">
        Source file
        <a :href="sourceUrl" rel="nofollow">{{ source }}</a>
        — the site is generated from it.
      </p>
    </template>
  </DefaultTheme.Layout>
</template>
