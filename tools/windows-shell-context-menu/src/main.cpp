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
        PostMessageW(owner, WM_NULL, 0, 0);
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
