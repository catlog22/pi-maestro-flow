// ---------------------------------------------------------------------------
// Route Configuration — guide-only inventory for the pi-maestro-flow docs site
// ---------------------------------------------------------------------------

import { getAllGuideMeta, guideCategories } from '../data/staticLoader.js';

// Re-export category metadata for layout components
export { guideCategories };
export type { GuideCategory } from '../data/staticLoader.js';

export interface GuideMeta {
  slug: string;
  file: string;
  file_en?: string;
  title: string;
  description: string;
  title_zh: string;
  description_zh: string;
  icon: string;
  category: string;
}

export interface SearchResult {
  type: 'guide';
  slug: string;
  name: string;
  description: string;
  descriptionZh?: string;
  category: string;
  categoryZh: string;
}

export function getAllGuides(): GuideMeta[] {
  return getAllGuideMeta();
}

export function getGuidesByCategory(categoryId: string): GuideMeta[] {
  return getAllGuideMeta().filter((g) => g.category === categoryId);
}

/**
 * Case-insensitive keyword search over guide title + description.
 */
export function searchGuides(query: string, categoryFilter?: string): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const catZh = (id: string) => guideCategories.find((c) => c.id === id)?.title_zh ?? id;

  return getAllGuideMeta()
    .filter((g) => !categoryFilter || g.category === categoryFilter)
    .filter((g) =>
      [g.title, g.title_zh, g.description, g.description_zh, g.slug]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(q))
    )
    .map((g) => ({
      type: 'guide' as const,
      slug: g.slug,
      name: g.title_zh || g.title,
      description: g.description,
      descriptionZh: g.description_zh,
      category: g.category,
      categoryZh: catZh(g.category),
    }));
}
