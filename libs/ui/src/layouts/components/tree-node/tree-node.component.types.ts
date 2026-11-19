import { IconName } from '../../../content';

export interface TreeNode<T> {
  id: T;
  label: string;
  closedIcon: IconName;
  openIcon: IconName;

  children?: TreeNode<T>[];
  isOpen?: boolean;
  isSelected?: boolean;
  isLoading?: boolean;
  hasChildren?: boolean;
  hideMenu?: boolean;
  title?: string;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** Marks the first favorite belonging to a different drive/root. */
  groupStart?: boolean;
}
