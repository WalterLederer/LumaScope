import { dialog, IpcMainInvokeEvent } from 'electron';
import { ApiResponse } from 'internal-api';
import { IpcHandler } from '../app/decorators/ipc-handler';

export class Dialogs {
  @IpcHandler({ name: 'Dialogs.saveFile' })
  readonly saveFile = async (_: IpcMainInvokeEvent, defaultPath?: string): Promise<ApiResponse<string>> => {
    const result = await dialog.showSaveDialog({
      title: 'Save GPX track',
      defaultPath,
      filters: [{ name: 'GPX files', extensions: ['gpx'] }]
    });

    return (result.canceled || !result.filePath)
      ? { success: false, errorMessage: '' }
      : { success: true, data: result.filePath };
  };

  @IpcHandler({ name: 'Dialogs.openFolder' })
  readonly openFolder = async (_: IpcMainInvokeEvent, initialPath?: string): Promise<ApiResponse<string>> => {
    const result = await dialog.showOpenDialog({ defaultPath: initialPath, properties: [ 'openDirectory' ] });

    return (result.canceled || result.filePaths.length === 0)
      ? { success: false, errorMessage: '' }
      : { success: true, data: result.filePaths[0] };
  };
}
