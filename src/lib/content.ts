// Build-time helpers over the generated content. Imported by Astro pages.
import data from '../data/sections.json';
import aliases from '../data/aliases.json';

export interface Section {
  key: string;
  title: string;
  depth: number;
  kind: string;
  file: string;
  wordcount: number;
  aliases: string[];
  html: string;
  md?: string;
  order: number;
  prev: string | null;
  next: string | null;
  parent: string | null;
}

export const sections: Section[] = data.sections as Section[];
export const byKey = new Map(sections.map((s) => [s.key, s]));
export const aliasToCanonical: Record<string, string> = aliases.aliasToCanonical;
export const aliasMap: Record<string, string[]> = aliases.aliasMap;

/** Direct children of a section, in reading order. */
export function childrenOf(key: string): Section[] {
  return sections.filter((s) => s.parent === key);
}

/** Resolve @@BASE@@ placeholders (in rewritten in-text links) to the real base. */
export function resolveBase(html: string, base: string): string {
  return html.replaceAll('@@BASE@@', base.endsWith('/') ? base : base + '/');
}

/** href to a section page, base-aware. */
export function sectionHref(base: string, key: string): string {
  const b = base.endsWith('/') ? base : base + '/';
  return `${b}s/${key}`;
}
