const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

// 배포(Packaged) 상태일 때 불필요한 콘솔 로그 및 디버그 출력 원천 차단
if (app.isPackaged) {
    console.log = function () {};
    console.warn = function () {};
    console.error = function () {};
}
function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 1. GUI 에셋 불러오기 (개발/빌드 포터블 환경 모두 대응)
ipcMain.handle('get-bundled-gui-asset', async (event, relPath) => {
    try {
        const basePath = app.isPackaged ? process.resourcesPath : app.getAppPath();
        const fullPath = path.join(basePath, relPath);

        if (fs.existsSync(fullPath)) {
            const base64Data = fs.readFileSync(fullPath).toString('base64');
            const dataUrl = `data:image/png;base64,${base64Data}`;
            return { status: 'success', data_url: dataUrl };
        } else {
            return { status: 'error', message: 'File not found: ' + fullPath };
        }
    } catch (err) {
        return { status: 'error', message: err.message };
    }
});

// 2. 리소스팩 내보내기 및 zip 압축
ipcMain.handle('export-pack', async (event, rawDataJson) => {
    try {
        const data = JSON.parse(rawDataJson);
        const packName = data.pack_name || "Minecraft_ResourcePack.zip";

        const { filePath } = await dialog.showSaveDialog({
            title: '리소스팩 저장',
            defaultPath: packName,
            filters: [{ name: 'Zip Files', extensions: ['zip'] }]
        });

        if (!filePath) {
            return { status: 'cancelled' };
        }

        const output = fs.createWriteStream(filePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        return new Promise((resolve, reject) => {
            output.on('close', () => {
                resolve({ status: 'success' });
            });

            archive.on('error', (err) => {
                reject({ status: 'error', message: err.message });
            });

            archive.pipe(output);

            // 2-1. pack.mcmeta 생성
            const mcmetaContent = {
                pack: {
                    pack_format: data.pack_format,
                    description: data.description || "",
                    supported_formats: [data.min_inclusive || data.pack_format, data.pack_format]
                }
            };
            archive.append(JSON.stringify(mcmetaContent, null, 2), { name: 'pack.mcmeta' });

            // 2-2. 아이템 텍스처 추가
            if (data.item_textures && Array.isArray(data.item_textures)) {
                data.item_textures.forEach(tex => {
                    if (tex.data_url) {
                        const base64Data = tex.data_url.replace(/^data:image\/png;base64,/, "");
                        const buffer = Buffer.from(base64Data, 'base64');
                        archive.append(buffer, { name: `assets/minecraft/textures/item/${tex.item_id}.png` });
                    }
                });
            }

            // 2-3. 아이템 모델 JSON 추가
            if (data.item_models && Array.isArray(data.item_models)) {
                const modelGroups = {};
                data.item_models.forEach(m => {
                    if (!modelGroups[m.base_item]) {
                        modelGroups[m.base_item] = [];
                    }
                    modelGroups[m.base_item].push(m);
                });

                for (let baseItem in modelGroups) {
                    const overrides = modelGroups[baseItem].map(m => ({
                        predicate: { custom_model_data: m.cmd },
                        model: `item/${m.texture_id}`
                    }));

                    const itemModelJson = {
                        parent: `item/generated`,
                        textures: {
                            layer0: `item/${baseItem}`
                        },
                        overrides: overrides
                    };

                    archive.append(JSON.stringify(itemModelJson, null, 2), { name: `assets/minecraft/models/item/${baseItem}.json` });

                    modelGroups[baseItem].forEach(m => {
                        const customModelJson = {
                            parent: `item/generated`,
                            textures: {
                                layer0: `item/${m.texture_id}`
                            }
                        };
                        archive.append(JSON.stringify(customModelJson, null, 2), { name: `assets/minecraft/models/item/${m.texture_id}.json` });
                    });
                }
            }

            // 2-4. GUI 텍스처 추가
            if (data.gui_textures && Array.isArray(data.gui_textures)) {
                data.gui_textures.forEach(gui => {
                    if (gui.data_url && gui.fileName) {
                        const base64Data = gui.data_url.replace(/^data:image\/png;base64,/, "");
                        const buffer = Buffer.from(base64Data, 'base64');
                        archive.append(buffer, { name: `assets/minecraft/textures/gui/${gui.fileName}` });
                    }
                });
            }

            // 2-5. 다국어 설정 추가
            if (data.lang_settings && data.lang_settings.data) {
                const langCode = data.lang_settings.code || "ko_kr";
                archive.append(JSON.stringify(data.lang_settings.data, null, 2), { name: `assets/minecraft/lang/${langCode}.json` });
            }

            archive.finalize();
        });

    } catch (err) {
        return { status: 'error', message: err.message };
    }
});