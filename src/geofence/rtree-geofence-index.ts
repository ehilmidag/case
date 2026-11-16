import { AreaBoundsIndex } from './area-bounds-index';
import { createCellUniformityChecker } from './cell-uniformity';
import { containsPoint } from './geometry';
import { AreaGeometry, GeofenceIndex } from './geofence-index';

export class RTreeGeofenceIndex implements GeofenceIndex {
  private readonly boundsIndex = new AreaBoundsIndex();
  private uniformCellChecker = createCellUniformityChecker(this.boundsIndex);
  private currentVersion = 0;

  get version(): number {
    return this.currentVersion;
  }

  rebuild(areas: AreaGeometry[], version: number): void {
    this.boundsIndex.rebuild(areas);
    this.uniformCellChecker = createCellUniformityChecker(this.boundsIndex);
    this.currentVersion = version;
  }

  findContaining(lat: number, lng: number): string[] {
    const candidateIndexes = this.boundsIndex.search({
      minLng: lng,
      minLat: lat,
      maxLng: lng,
      maxLat: lat,
    });

    return candidateIndexes
      .filter((index) => containsPoint(this.boundsIndex.getArea(index), lat, lng))
      .map((index) => this.boundsIndex.getArea(index).id)
      .sort();
  }

  isUniformCell(cell: string): boolean {
    return this.uniformCellChecker(cell);
  }
}
