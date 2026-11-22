#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <objbase.h>
#include <string>

namespace {
IContextMenu2* g_contextMenu2 = nullptr;
IContextMenu3* g_contextMenu3 = nullptr;

LRESULT CALLBACK MenuOwnerProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    if (g_contextMenu3) {
        LRESULT result = 0;
        if (g_contextMenu3->HandleMenuMsg2(message, wParam, lParam, &result) == S_OK) return result;
    }
    if (g_contextMenu2) {
        switch (message) {
        case WM_INITMENUPOPUP:
        case WM_DRAWITEM:
        case WM_MEASUREITEM:
        case WM_MENUCHAR:
            if (g_contextMenu2->HandleMenuMsg(message, wParam, lParam) == S_OK) return 0;
            break;
        default:
            break;
        }
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

bool HasVisibleOwnedWindow(HWND owner) {
    struct SearchState {
        HWND owner;
        bool found;
    } state{ owner, false };

    EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
        auto* search = reinterpret_cast<SearchState*>(parameter);
        if (GetWindow(window, GW_OWNER) == search->owner && IsWindowVisible(window)) {
            search->found = true;
            return FALSE;
        }
        return TRUE;
    }, reinterpret_cast<LPARAM>(&state));

    return state.found;
}

void PumpOwnedDialogMessages(HWND owner) {
    // Some shell verbs return as soon as they create a modeless dialog.
    // Keep the helper's owner window and its COM context-menu handler alive
    // until all visible top-level dialogs owned by it have been closed.
    while (HasVisibleOwnedWindow(owner)) {
        MSG message{};
        const BOOL result = GetMessageW(&message, nullptr, 0, 0);
        if (result <= 0) break;
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}

bool ParseInteger(const wchar_t* value, int& result) {
    if (!value || !*value) return false;
    wchar_t* end = nullptr;
    const long parsed = wcstol(value, &end, 10);
    if (!end || *end != L'\0' || parsed < -100000 || parsed > 100000) return false;
    result = static_cast<int>(parsed);
    return true;
}

int Run(const std::wstring& filePath, int x, int y) {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized)) return 10;

    const wchar_t* className = L"LumaScopeShellContextMenuOwner";
    WNDCLASSW windowClass{};
    windowClass.lpfnWndProc = MenuOwnerProc;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.lpszClassName = className;
    RegisterClassW(&windowClass);

    // A tiny helper-owned window receives IContextMenu2/3 owner-draw and
    // submenu messages. It is separate from Electron so the native shell
    // extension message protocol remains intact.
    HWND owner = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, className, L"",
        WS_POPUP, x, y, 1, 1, nullptr, nullptr, windowClass.hInstance, nullptr);
    if (!owner) {
        CoUninitialize();
        return 11;
    }

    PIDLIST_ABSOLUTE absoluteItem = nullptr;
    HRESULT result = SHParseDisplayName(filePath.c_str(), nullptr, &absoluteItem, 0, nullptr);
    if (FAILED(result) || !absoluteItem) {
        DestroyWindow(owner);
        CoUninitialize();
        return 12;
    }

    IShellFolder* parentFolder = nullptr;
    PCUITEMID_CHILD childItem = nullptr;
    result = SHBindToParent(absoluteItem, IID_PPV_ARGS(&parentFolder), &childItem);
    if (FAILED(result) || !parentFolder || !childItem) {
        CoTaskMemFree(absoluteItem);
        DestroyWindow(owner);
        CoUninitialize();
        return 13;
    }

    IContextMenu* contextMenu = nullptr;
    result = parentFolder->GetUIObjectOf(owner, 1, &childItem, IID_IContextMenu, nullptr,
        reinterpret_cast<void**>(&contextMenu));
    parentFolder->Release();
    CoTaskMemFree(absoluteItem);
    if (FAILED(result) || !contextMenu) {
        DestroyWindow(owner);
        CoUninitialize();
        return 14;
    }

    contextMenu->QueryInterface(IID_PPV_ARGS(&g_contextMenu2));
    contextMenu->QueryInterface(IID_PPV_ARGS(&g_contextMenu3));

    HMENU menu = CreatePopupMenu();
    if (!menu) {
        if (g_contextMenu3) { g_contextMenu3->Release(); g_contextMenu3 = nullptr; }
        if (g_contextMenu2) { g_contextMenu2->Release(); g_contextMenu2 = nullptr; }
        contextMenu->Release();
        DestroyWindow(owner);
        CoUninitialize();
        return 15;
    }

    constexpr UINT firstCommand = 1;
    constexpr UINT lastCommand = 0x7FFF;
    result = contextMenu->QueryContextMenu(menu, 0, firstCommand, lastCommand, CMF_NORMAL);
    if (SUCCEEDED(result)) {
        ShowWindow(owner, SW_SHOWNOACTIVATE);
        SetForegroundWindow(owner);
        const UINT selected = TrackPopupMenuEx(menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_LEFTALIGN | TPM_TOPALIGN,
            x, y, owner, nullptr);
        if (selected >= firstCommand && selected <= lastCommand) {
            char verb[256]{};
            const bool hasCanonicalVerb =
                SUCCEEDED(contextMenu->GetCommandString(selected - firstCommand, GCS_VERBA,
                    nullptr, verb, static_cast<UINT>(sizeof(verb))))
                && verb[0] != '\\0';

            bool invoked = false;
            if (hasCanonicalVerb) {
                // Use ShellExecuteEx for canonical context-menu verbs. This is
                // the Shell's supported invocation path for both built-in verbs
                // (Properties, Print) and verbs supplied by context-menu
                // extensions (for example Advanced Security).
                SHELLEXECUTEINFOW executeInfo{};
                executeInfo.cbSize = sizeof(executeInfo);
                executeInfo.fMask = SEE_MASK_INVOKEIDLIST;
                executeInfo.hwnd = owner;
                const int verbLength = MultiByteToWideChar(CP_ACP, 0, verb, -1, nullptr, 0);
                std::wstring wideVerb(static_cast<size_t>(verbLength), L'\\0');
                if (verbLength > 1 &&
                    MultiByteToWideChar(CP_ACP, 0, verb, -1, wideVerb.data(), verbLength) > 0) {
                    wideVerb.resize(static_cast<size_t>(verbLength - 1));
                    executeInfo.lpVerb = wideVerb.c_str();
                    executeInfo.lpFile = filePath.c_str();
                    executeInfo.nShow = SW_SHOWNORMAL;
                    invoked = ShellExecuteExW(&executeInfo) == TRUE;
                }
            }

            if (!invoked) {
                // Some third-party handlers expose menu commands without a
                // canonical verb. Preserve support for those via IContextMenu.
                CMINVOKECOMMANDINFOEX invoke{};
                invoke.cbSize = sizeof(invoke);
                invoke.fMask = CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE;
                invoke.hwnd = owner;
                invoke.lpVerb = MAKEINTRESOURCEA(selected - firstCommand);
                invoke.lpVerbW = MAKEINTRESOURCEW(selected - firstCommand);
                invoke.nShow = SW_SHOWNORMAL;
                invoke.ptInvoke = POINT{ x, y };
                contextMenu->InvokeCommand(reinterpret_cast<LPCMINVOKECOMMANDINFO>(&invoke));
            }

            // This covers native dialogs opened by shell verbs such as
            // Advanced Security, as well as the Properties dialog above.
            PumpOwnedDialogMessages(owner);
            PostMessageW(owner, WM_NULL, 0, 0);
        } else {
            PostMessageW(owner, WM_NULL, 0, 0);
        }
    }

    DestroyMenu(menu);
    if (g_contextMenu3) { g_contextMenu3->Release(); g_contextMenu3 = nullptr; }
    if (g_contextMenu2) { g_contextMenu2->Release(); g_contextMenu2 = nullptr; }
    contextMenu->Release();
    DestroyWindow(owner);
    CoUninitialize();
    return SUCCEEDED(result) ? 0 : 16;
}
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    int argumentCount = 0;
    LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
    if (!arguments) return 2;
    if (argumentCount != 4) {
        LocalFree(arguments);
        return 3;
    }

    int x = 0;
    int y = 0;
    const bool valid = ParseInteger(arguments[2], x) && ParseInteger(arguments[3], y);
    const std::wstring path = arguments[1];
    LocalFree(arguments);
    if (!valid || path.empty()) return 4;
    return Run(path, x, y);
}
