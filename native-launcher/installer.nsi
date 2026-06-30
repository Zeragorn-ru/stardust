; NSIS installer for StarDust Launcher (Beta / Native).
;
; Usage:
;   makensis -DVERSION=0.5.7 -DEXE_PATH=stardust-native.exe -DBS_PATH=bootstrap.exe installer.nsi
;
; Silent install (used by updater via bootstrap):
;   stardust-native-v0.5.7-setup.exe /S /D=<install_dir>

!include "MUI2.nsh"

Name "StarDust Launcher"
OutFile "stardust-native-v${VERSION}-setup.exe"
InstallDir "$LOCALAPPDATA\stardust-beta"
InstallDirRegKey HKCU "Software\StarDust\Beta" "InstallDir"
RequestExecutionLevel user

; Параметры по умолчанию (переопределяются -D из командной строки)
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef EXE_PATH
  !define EXE_PATH "stardust-native.exe"
!endif
!ifndef BS_PATH
  !define BS_PATH "bootstrap.exe"
!endif

var StartMenuGroup

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; Определяем папку меню «Пуск»
  StrCpy $StartMenuGroup "StarDust Beta"
FunctionEnd

Section "Install"
  SetOutPath $INSTDIR

  ; Файлы лаунчера
  File "${EXE_PATH}"
  File "${BS_PATH}"

  ; Запоминаем путь установки
  WriteRegStr HKCU "Software\StarDust\Beta" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\StarDust\Beta" "Version" "${VERSION}"

  ; Удалитель
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Ярлык в меню «Пуск»
  CreateDirectory "$SMPROGRAMS\$StartMenuGroup"
  CreateShortCut "$SMPROGRAMS\$StartMenuGroup\StarDust Beta.lnk" "$INSTDIR\${EXE_PATH}" "" "$INSTDIR\${EXE_PATH}" 0
  CreateShortCut "$SMPROGRAMS\$StartMenuGroup\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  ; Запись в «Установка и удаление программ»
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarDustBeta" \
    "DisplayName" "StarDust Launcher (Beta)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarDustBeta" \
    "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarDustBeta" \
    "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarDustBeta" \
    "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarDustBeta" \
    "Publisher" "StarDust"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarDustBeta" \
    "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarDustBeta" \
    "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${EXE_PATH}"
  Delete "$INSTDIR\${BS_PATH}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\$StartMenuGroup\StarDust Beta.lnk"
  Delete "$SMPROGRAMS\$StartMenuGroup\Uninstall.lnk"
  RMDir "$SMPROGRAMS\$StartMenuGroup"

  DeleteRegKey HKCU "Software\StarDust\Beta"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarDustBeta"
SectionEnd
