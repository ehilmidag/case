import Flatbush from 'flatbush';
import { AreaGeometry } from './geofence-index';
import { Bounds, getBounds } from './geometry';

export class AreaBoundsIndex {
  private tree: Flatbush | undefined;
  private indexedAreas: AreaGeometry[] = [];
  private indexedBounds: Bounds[] = [];

  rebuild(areas: AreaGeometry[]): void {
    const tree = areas.length > 0 ? new Flatbush(areas.length) : undefined;
    const bounds = areas.map(({ geometry }) => getBounds(geometry));

    bounds.forEach(({ minLng, minLat, maxLng, maxLat }) => {
      tree?.add(minLng, minLat, maxLng, maxLat);
    });
    tree?.finish();

    this.indexedAreas = [...areas];
    this.indexedBounds = bounds;
    this.tree = tree;
  }

  search(bounds: Bounds): number[] {
    return this.tree?.search(bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat) ?? [];
  }

  getArea(index: number): AreaGeometry {
    return this.indexedAreas[index];
  }

  getBounds(index: number): Bounds {
    return this.indexedBounds[index];
  }

  get size(): number {
    return this.indexedAreas.length;
  }
}
