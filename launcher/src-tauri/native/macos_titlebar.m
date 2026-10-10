#import <AppKit/AppKit.h>

// Нативная шапка macOS: полоса 38pt во всю ширину окна, traffic lights
// по вертикальному центру полосы, заголовок окна «StarDust» по центру окна.
//
// Почему не CSS/конфиг: AppKit центрирует заголовок между accessory-группами,
// а trafficLightPosition в tao ужимает NSTitlebarContainerView до
// height(кнопки)+y и прижимает кнопки к верху — отсюда «утонувший» светофор.
// Здесь раскладка применяется один раз, ПОСЛЕ применения нативных масок tauri
// (async main-queue в tao), поэтому ничего её не перетирает.

static NSString *rectStr(NSRect r) {
  return [NSString stringWithFormat:@"(x=%.1f y=%.1f w=%.1f h=%.1f)",
      r.origin.x, r.origin.y, r.size.width, r.size.height];
}

// NSTextField заголовка живёт в NSTitlebarView внутри NSTitlebarContainerView.
// Не приватный API: стандартные subviews, которые создаёт сам AppKit
// (как в известном сниппете winit/tao для скрытия заголовка).
static NSTextField *findTitleField(NSWindow *w) {
  for (NSView *container in w.contentView.superview.subviews) {
    for (NSView *bar in container.subviews) {
      for (NSView *view in bar.subviews) {
        if ([view isKindOfClass:[NSTextField class]]) {
          NSTextField *field = (NSTextField *)view;
          if (field.stringValue.length > 0) {
            return field;
          }
        }
      }
    }
  }
  return nil;
}

void stardust_configure_macos_titlebar(void *windowPtr) {
  if (windowPtr == NULL) {
    return;
  }
  NSWindow *w = (__bridge NSWindow *)windowPtr;

  NSButton *close = [w standardWindowButton:NSWindowCloseButton];
  if (close == nil) {
    return;
  }
  NSView *container = close.superview.superview; // NSTitlebarContainerView

  // 1) Полоса ровно 38pt, прижата к верху окна (AppKit-координаты: снизу).
  CGFloat const barHeight = 38.0;
  NSRect bar = container.frame;
  bar.size.height = barHeight;
  bar.origin.y = w.frame.size.height - barHeight;
  [container setFrame:bar];

  // 2) Traffic lights: x оставляем системный (9/32/55), y — центр полосы.
  CGFloat const buttonY = (barHeight - close.frame.size.height) / 2.0;
  NSArray *buttons = @[
    close,
    [w standardWindowButton:NSWindowMiniaturizeButton],
    [w standardWindowButton:NSWindowZoomButton],
  ];
  for (NSButton *button in buttons) {
    NSRect r = button.frame;
    r.origin.y = buttonY;
    [button setFrameOrigin:r.origin];
  }

  // 3) Заголовок — по центру окна и по вертикальному центру полосы.
  NSTextField *title = findTitleField(w);
  if (title != nil) {
    NSRect tf = title.frame;
    tf.origin.x = (w.frame.size.width - tf.size.width) / 2.0;
    tf.origin.y = (barHeight - tf.size.height) / 2.0;
    [title setFrame:tf];
  }

  NSLog(@"[stardust] titlebar: container %@ title %@ close %@",
      rectStr(container.frame),
      title != nil ? rectStr([title convertRect:title.bounds toView:nil]) : @"(none)",
      rectStr([close convertRect:close.bounds toView:nil]));
}
