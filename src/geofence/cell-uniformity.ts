import { LRUCache } from 'lru-cache';
import { AreaBoundsIndex } from './area-bounds-index';
import { cellIsUniform, getBounds, getCellPolygon } from './geometry';

export const DEFAULT_UNIFORM_CELL_CACHE_SIZE = 50_000;

export function createCellUniformityChecker(
  areas: AreaBoundsIndex,
  cacheSize = DEFAULT_UNIFORM_CELL_CACHE_SIZE,
): (cell: string) => boolean {
  const cache = new LRUCache<string, boolean>({ max: cacheSize });

  return (cell: string): boolean => {
    const cached = cache.get(cell);
    if (cached !== undefined) {
      return cached;
    }

    const polygon = getCellPolygon(cell);
    const bounds = getBounds(polygon);
    const uniform = areas
      .search(bounds)
      .every((areaIndex) => cellIsUniform(polygon, areas.getArea(areaIndex)));

    cache.set(cell, uniform);
    return uniform;
  };
}
