import { TreeNode } from '@light-matter/ui';
import { allSortDirections, allSortTypes, SortDirection, SortType } from 'internal-api';

export const galleryRoot = (): TreeNode<string> => ({
  id: '',
  label: 'My PC',
  openIcon: 'desktopColor',
  closedIcon: 'desktopOff',
  isOpen: true,
  children: []
});

export const treeNode = (location: string, hideMenu: boolean): TreeNode<string> => ({
  id: location,
  label: formatLocationName(location),
  openIcon: 'folderOpenFilled',
  closedIcon: 'folderFilled',
  hideMenu
});

export const formatLocationName = (value: string): string => value.split(/[/\\]/g).pop() ?? value;

export const formatCompactPath = (value: string, maxLength = 52): string => {
  if (value.length <= maxLength) return value;
  const available = maxLength - 3;
  const prefixLength = Math.ceil(available * 0.38);
  const suffixLength = available - prefixLength;
  return `${value.slice(0, prefixLength)}...${value.slice(-suffixLength)}`;
};

export interface SortMode {
  sortBy: SortType;
  sortDir: SortDirection;
}

export const defaultSortMode = (): SortMode => ({
  sortBy: allSortTypes[0],
  sortDir: allSortDirections[0]
});
