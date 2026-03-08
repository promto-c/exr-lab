export function getScanlineLinesPerBlock(compression: number): number {
  switch (compression) {
    case 0:
    case 1:
    case 2:
      return 1;
    case 3:
    case 5:
      return 16;
    case 4:
    case 6:
    case 7:
    case 8:
      return 32;
    case 9:
      return 256;
    default:
      return 1;
  }
}
