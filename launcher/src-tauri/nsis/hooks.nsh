; NSIS installer hooks for StarDust.
;
; Tauri вызывает эти макросы на соответствующих этапах работы
; установщика/деинсталлятора. Здесь мы при удалении программы
; предлагаем также стереть данные лаунчера (Java, клиент Minecraft,
; NeoForge, ассеты, настройки и сессию) из %APPDATA%.
;
; Идентификатор приложения берётся из `identifier` в tauri.conf.json:
;   com.stardust.launcher  ->  %APPDATA%\com.stardust.launcher
!macro NSIS_HOOK_PREINSTALL
  StrCpy $0 "$APPDATA\com.stardust.launcher"
  StrCpy $1 "$APPDATA\com.project.launcher"
  IfFileExists "$0\*.*" migration_done 0
  IfFileExists "$1\*.*" 0 migration_done
    Rename "$1" "$0"
  migration_done:
!macroend

; Переменная для хранения состояния CheckBox «Запустить после установки».
Var LaunchAfterInstall

; Добавляем CheckBox на финальную страницу MUI (только при обычной установке).
!macro NSIS_HOOK_PREFINCISH
  IfSilent skip_checkbox 0
    ${NSD_CreateCheckbox} 120u 130u 100% 10u "Запустить StarDust после установки"
    Pop $LaunchAfterInstall
    ${NSD_SetState} $LaunchAfterInstall ${BST_CHECKED}
  skip_checkbox:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Автообновление запускает NSIS с /S — сразу запускаем лаунчер.
  IfSilent launch_app check_checkbox

  check_checkbox:
    ; Обычная установка: запускаем только если галочка отмечена.
    ${NSD_GetState} $LaunchAfterInstall $0
    IntCmp $0 ${BST_CHECKED} launch_app launch_done launch_done

  launch_app:
    ; Читаем путь установки из реестра — $INSTDIR может быть пустым
    ; если хук вызывается до его инициализации Tauri.
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\StarDust" "InstallLocation"
    StrCmp $0 "" use_instdir 0
    StrCpy $INSTDIR $0

  use_instdir:
    ; Убиваем старый процесс если он ещё жив.
    ExecWait 'taskkill /F /IM StarDust.exe' $0
    Sleep 500

    ; Ждём пока инсталлятор завершит запись файлов (до 10 сек).
    wait_for_exe:
      IfFileExists "$INSTDIR\StarDust.exe" 0 exe_not_ready
        Goto exe_ready
      exe_not_ready:
        Sleep 500
        Goto wait_for_exe
    exe_ready:

    ; Запускаем лаунчер: cmd /C START "" ... отсоединяет процесс от инсталлятора.
    ExecWait 'cmd /C START "" "$INSTDIR\StarDust.exe"'

  launch_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Спрашиваем пользователя: по умолчанию (кнопка No) данные сохраняются,
  ; чтобы случайно не потерять миры/настройки. Yes — полное удаление.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Удалить также все данные лаунчера?$\r$\n$\r$\nБудут стёрты: Java, клиент Minecraft, NeoForge, ассеты, моды, настройки и данные входа.$\r$\n$\r$\nНажмите «Нет», чтобы сохранить их для будущей переустановки." \
    /SD IDNO IDYES delete_appdata IDNO keep_appdata

  delete_appdata:
    RMDir /r "$APPDATA\com.stardust.launcher"
    Goto appdata_done

  keep_appdata:
  appdata_done:
!macroend
