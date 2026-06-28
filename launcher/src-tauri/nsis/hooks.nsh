; NSIS installer hooks for StarDust.
;
; Tauri вызывает эти макросы на соответствующих этапах работы
; установщика/деинсталлятора. Здесь мы при удалении программы
; предлагаем также стереть данные лаунчера (Java, клиент Minecraft,
; NeoForge, ассеты, настройки и сессию) из %APPDATA%.
;
; Идентификатор приложения берётся из `identifier` в tauri.conf.json:
;   com.project.launcher  ->  %APPDATA%\com.project.launcher

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
    IfFileExists "$INSTDIR\StarDust.exe" 0 launch_done

    ; Ждём 5 секунд — этого достаточно для штатного завершения старого
    ; лаунчера (app.exit(0) в Rust закрывает процесс мгновенно).
    Sleep 5000

    ; Если старый процесс всё ещё висит — убиваем принудительно.
    ; taskkill /F /IM завершит все процессы с таким именем.
    Exec 'taskkill /F /IM StarDust.exe'
    ; Пауза после kill чтобы ОС завершила cleanup.
    Sleep 1000

    ; Запускаем лаунчер через explorer.exe чтобы процесс стартовал
    ; в контексте пользователя, а не elevated NSIS-процесса.
    Exec '"$WINDIR\explorer.exe" "$INSTDIR\StarDust.exe"'

  launch_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Спрашиваем пользователя: по умолчанию (кнопка No) данные сохраняются,
  ; чтобы случайно не потерять миры/настройки. Yes — полное удаление.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Удалить также все данные лаунчера?$\r$\n$\r$\nБудут стёрты: Java, клиент Minecraft, NeoForge, ассеты, моды, настройки и данные входа.$\r$\n$\r$\nНажмите «Нет», чтобы сохранить их для будущей переустановки." \
    /SD IDNO IDYES delete_appdata IDNO keep_appdata

  delete_appdata:
    RMDir /r "$APPDATA\com.project.launcher"
    Goto appdata_done

  keep_appdata:
  appdata_done:
!macroend
