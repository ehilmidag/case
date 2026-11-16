import { latLngToCell, polygonToCellsExperimental, POLYGON_TO_CELLS_FLAGS } from 'h3-js';
import { AreaBoundsIndex } from './area-bounds-index';
import { createCellUniformityChecker } from './cell-uniformity';
import { containsPoint } from './geometry';
import { AreaGeometry, GeofenceIndex } from './geofence-index';

type CellAreas = {
  interior: Set<string>;
  boundary: Set<string>;
};

export class H3GeofenceIndex implements GeofenceIndex {
  private readonly boundsIndex = new AreaBoundsIndex();
  private readonly cellAreas = new Map<string, CellAreas>();
  private uniformCellChecker = createCellUniformityChecker(this.boundsIndex);
  private currentVersion = 0;

  constructor(private readonly resolution = 9) {}

  get version(): number {
    return this.currentVersion;
  }

  rebuild(areas: AreaGeometry[], version: number): void {
    this.boundsIndex.rebuild(areas);
    this.cellAreas.clear();

    for (const area of areas) {
      const cells = polygonToCellsExperimental(
        area.geometry.coordinates,
        this.resolution,
        POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
        true,
      );
      const interiorCells = new Set(
        polygonToCellsExperimental(
          area.geometry.coordinates,
          this.resolution,
          POLYGON_TO_CELLS_FLAGS.containmentFull,
          true,
        ),
      );

      for (const cell of cells) {
        const kind = interiorCells.has(cell) ? 'interior' : 'boundary';
        const entry = this.cellAreas.get(cell) ?? {
          interior: new Set<string>(),
          boundary: new Set<string>(),
        };

        entry[kind].add(area.id);
        this.cellAreas.set(cell, entry);
      }
    }

    this.uniformCellChecker = createCellUniformityChecker(this.boundsIndex);
    this.currentVersion = version;
  }

  findContaining(lat: number, lng: number): string[] {
    const cell = this.getCell(lat, lng);
    const cellMatches = this.cellAreas.get(cell);
    if (!cellMatches) {
      return [];
    }

    const matches = new Set(cellMatches.interior);
    const pointCandidates = this.boundsIndex.search({
      minLng: lng,
      minLat: lat,
      maxLng: lng,
      maxLat: lat,
    });
    const candidateAreas = pointCandidates.map((index) => this.boundsIndex.getArea(index));

    for (const areaId of cellMatches.boundary) {
      const area = candidateAreas.find((candidate) => candidate.id === areaId);
      if (area && containsPoint(area, lat, lng)) {
        matches.add(areaId);
      }
    }

    return [...matches].sort();
  }

  isUniformCell(cell: string): boolean {
    return this.uniformCellChecker(cell);
  }

  private getCell(lat: number, lng: number): string {
    return latLngToCell(lat, lng, this.resolution);
  }
}
