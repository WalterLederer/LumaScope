import { TreeNode } from '@light-matter/ui';
import { allSortDirections, allSortTypes, SortDirection, SortType } from 'internal-api';

export const galleryRoot = (): TreeNode<string> => ({
  id: '',
  label: 'My PC',
  openIcon: 'desktopColor',
  closedIcon: 'desktopColor',
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

export interface SortMode {
  sortBy: SortType;
  sortDir: SortDirection;
}

export const defaultSortMode = (): SortMode => ({
  sortBy: allSortTypes[0],
  sortDir: allSortDirections[0]
});
