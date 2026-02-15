export const EXR_MAGIC = 20000630; // 0x762f3101

export const PIXEL_TYPES = {
  0: 'UINT',
  1: 'HALF',
  2: 'FLOAT'
};

export const COMPRESSION_NAMES = {
  0: 'NO_COMPRESSION',
  1: 'RLE_COMPRESSION',
  2: 'ZIPS_COMPRESSION',
  3: 'ZIP_COMPRESSION',
  4: 'PIZ_COMPRESSION',
  5: 'PXR24_COMPRESSION',
  6: 'B44_COMPRESSION',
  7: 'B44A_COMPRESSION',
  8: 'DWAA_COMPRESSION',
  9: 'DWAB_COMPRESSION',
};

export const ATTRIBUTE_TYPES = {
  BOX2I: 'box2i',
  BOX2F: 'box2f',
  CHLIST: 'chlist',
  COMPRESSION: 'compression',
  FLOAT: 'float',
  INT: 'int',
  LINEORDER: 'lineOrder',
  STRING: 'string',
  V2I: 'v2i',
  V2F: 'v2f',
  V3I: 'v3i',
  V3F: 'v3f',
};