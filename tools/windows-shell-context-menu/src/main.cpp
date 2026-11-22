#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <objbase.h>
#include <string>
#include <cstdio>

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

void PumpForegroundOwnedDialogMessages(HWND owner) {
    // Keep the COM context-menu handler alive only when the selected verb has
    // actually activated a dialog owned by this helper. Do not wait for hidden
    // or unrelated shell windows: they can otherwise hold focus in the helper
    // for several seconds without displaying any useful UI.
    HWND dialog = GetForegroundWindow();
    if (!dialog || dialog == owner || GetAncestor(dialog, GA_ROOTOWNER) != owner) return;

    while (IsWindow(dialog)) {
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
    if (FAILED(result)) {
        fwprintf(stderr, L"[LumaScope] IContextMenu::QueryContextMenu failed: HRESULT=0x%08lX\n",
            static_cast<unsigned long>(result));
    }
    if (SUCCEEDED(result)) {
        ShowWindow(owner, SW_SHOWNOACTIVATE);
        SetForegroundWindow(owner);
        const UINT selected = TrackPopupMenuEx(menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_LEFTALIGN | TPM_TOPALIGN,
            x, y, owner, nullptr);
        if (selected >= firstCommand && selected <= lastCommand) {
            // Resolve the canonical verb from this exact handler and invoke
            // it on the same IContextMenu instance. Fall back to its command
            // offset only for extensions that do not expose a canonical verb.
            wchar_t canonicalVerb[256]{};
            const bool hasCanonicalVerb =
                SUCCEEDED(contextMenu->GetCommandString(selected - firstCommand, GCS_VERBW,
                    nullptr, reinterpret_cast<LPSTR>(canonicalVerb),
                    static_cast<UINT>(sizeof(canonicalVerb) / sizeof(canonicalVerb[0]))))
                && canonicalVerb[0] != L'\0';

            CMINVOKECOMMANDINFOEX invoke{};
            invoke.cbSize = sizeof(invoke);
            invoke.fMask = CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE;
            invoke.hwnd = owner;
            invoke.lpVerb = hasCanonicalVerb
                ? nullptr
                : MAKEINTRESOURCEA(selected - firstCommand);
            invoke.lpVerbW = hasCanonicalVerb
                ? canonicalVerb
                : MAKEINTRESOURCEW(selected - firstCommand);
            invoke.nShow = SW_SHOWNORMAL;
            invoke.ptInvoke = POINT{ x, y };
            HRESULT invokeResult =
                contextMenu->InvokeCommand(reinterpret_cast<LPCMINVOKECOMMANDINFO>(&invoke));
            if (FAILED(invokeResult)) {
                // Some third-party shell extensions reject the extended Unicode /
                // point-invocation structure even when the verb is valid. Retry
                // with the classic, ordinal-based structure used by Explorer.
                fwprintf(stderr, L"[LumaScope] Extended InvokeCommand failed: HRESULT=0x%08lX, verb=%ls; retrying ordinal %u\n",
                    static_cast<unsigned long>(invokeResult), hasCanonicalVerb ? canonicalVerb : L"<numeric-command>",
                    selected - firstCommand);
                CMINVOKECOMMANDINFO retry{};
                retry.cbSize = sizeof(retry);
                retry.hwnd = owner;
                retry.lpVerb = MAKEINTRESOURCEA(selected - firstCommand);
                retry.nShow = SW_SHOWNORMAL;
                invokeResult = contextMenu->InvokeCommand(&retry);
            }
            if (FAILED(invokeResult)) {
                fwprintf(stderr, L"[LumaScope] IContextMenu::InvokeCommand retry failed: HRESULT=0x%08lX\n",
                    static_cast<unsigned long>(invokeResult));
                DestroyMenu(menu);
                if (g_contextMenu3) { g_contextMenu3->Release(); g_contextMenu3 = nullptr; }
                if (g_contextMenu2) { g_contextMenu2->Release(); g_contextMenu2 = nullptr; }
                contextMenu->Release();
                DestroyWindow(owner);
                CoUninitialize();
                return 17;
            }

            // This covers native dialogs opened by shell verbs such as
            // Advanced Security, as well as the Properties dialog above.
            PumpForegroundOwnedDialogMessages(owner);
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
