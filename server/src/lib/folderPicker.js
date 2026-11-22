import { execFile } from 'node:child_process';
import { FOLDER_PICKER_ENABLED } from '../config.js';

export class FolderPickerUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FolderPickerUnsupportedError';
  }
}

const CANCEL_HINTS = ['user canceled', 'user cancelled', '(-128)', 'cancelled', 'canceled'];

const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

function assertSupported() {
  if (!FOLDER_PICKER_ENABLED) {
    throw new FolderPickerUnsupportedError('目录/文件选择功能已被 DISABLE_FOLDER_PICKER 关闭');
  }
  if (process.platform !== 'darwin') {
    throw new FolderPickerUnsupportedError(`当前系统（${process.platform}）暂不支持原生选择框，请手动填写路径`);
  }
}

function runChoose(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: DIALOG_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message).trim();
        const normalized = message.toLowerCase();
        if (CANCEL_HINTS.some((hint) => normalized.includes(hint))) {
          resolve({ cancelled: true });
          return;
        }
        reject(new Error(`打开选择框失败：${message}`));
        return;
      }
      const selected = String(stdout).trim().replace(/\/+$/, '');
      if (!selected) {
        resolve({ cancelled: true });
        return;
      }
      resolve({ path: selected });
    });
  });
}

/**
 * 调起系统原生「选择文件夹」对话框（macOS）
 * 返回 { path } 或 { cancelled: true }
 */
export function pickDirectory({ prompt = '请选择导出目录' } = {}) {
  try {
    assertSupported();
  } catch (error) {
    return Promise.reject(error);
  }
  const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`;
  return runChoose(script);
}

/**
 * 调起系统原生「选择文件」对话框（macOS），用于选择 ISO 镜像
 * 返回 { path } 或 { cancelled: true }
 */
export function pickFile({ prompt = '请选择文件' } = {}) {
  try {
    assertSupported();
  } catch (error) {
    return Promise.reject(error);
  }
  const script = `POSIX path of (choose file with prompt ${JSON.stringify(prompt)})`;
  return runChoose(script);
}
