#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <node_api.h>
#include <vector>

static NSMutableArray *elements;
static pid_t observedPid;

static id attribute(AXUIElementRef element, CFStringRef key) {
    CFTypeRef value = nullptr;
    return AXUIElementCopyAttributeValue(element, key, &value) == kAXErrorSuccess ? CFBridgingRelease(value) : nil;
}

static NSString *shortText(id value) {
    if (![value isKindOfClass:NSString.class] && ![value isKindOfClass:NSNumber.class]) return @"";
    NSString *text = [value description];
    return text.length > 220 ? [text substringToIndex:220] : text;
}

static NSDictionary *appInfo(NSRunningApplication *app) {
    if (!app) return @{};
    return @{ @"pid": @(app.processIdentifier), @"name": app.localizedName ?: @"", @"bundleId": app.bundleIdentifier ?: @"" };
}

static bool geometry(AXUIElementRef element, CGPoint *point, CGSize *size) {
    id position = attribute(element, kAXPositionAttribute);
    id dimensions = attribute(element, kAXSizeAttribute);
    if (!position || !dimensions || CFGetTypeID((__bridge CFTypeRef)position) != AXValueGetTypeID()
        || CFGetTypeID((__bridge CFTypeRef)dimensions) != AXValueGetTypeID()) return false;
    return AXValueGetValue((__bridge AXValueRef)position, kAXValueTypeCGPoint, point)
        && AXValueGetValue((__bridge AXValueRef)dimensions, kAXValueTypeCGSize, size);
}

static void inspect(AXUIElementRef element, int depth, NSTimeInterval deadline, NSMutableArray *rows) {
    if (depth > 18 || elements.count >= 110 || NSDate.timeIntervalSinceReferenceDate > deadline) return;
    AXUIElementSetMessagingTimeout(element, 0.12f);
    NSString *role = shortText(attribute(element, kAXRoleAttribute));
    NSString *title = shortText(attribute(element, kAXTitleAttribute));
    if (!title.length) title = shortText(attribute(element, kAXDescriptionAttribute));
    if (!title.length) title = shortText(attribute(element, kAXPlaceholderValueAttribute));
    NSString *subrole = shortText(attribute(element, kAXSubroleAttribute));
    NSString *value = [subrole isEqualToString:@"AXSecureTextField"] ? @"" : shortText(attribute(element, kAXValueAttribute));
    if (title.length || value.length || [@[@"AXButton", @"AXTextField", @"AXTextArea", @"AXCheckBox", @"AXPopUpButton"] containsObject:role]) {
        [elements addObject:(__bridge id)element];
        [rows addObject:@{ @"id": @(elements.count), @"depth": @(depth), @"role": role, @"title": title, @"value": value }];
    }
    id children = attribute(element, kAXChildrenAttribute);
    if (![children isKindOfClass:NSArray.class]) return;
    for (id child in children) {
        if (elements.count >= 110 || NSDate.timeIntervalSinceReferenceDate > deadline) break;
        if (CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID()) {
            inspect((__bridge AXUIElementRef)child, depth + 1, deadline, rows);
        }
    }
}

static bool click(CGPoint location, bool right, int clicks) {
    CGMouseButton button = right ? kCGMouseButtonRight : kCGMouseButtonLeft;
    for (int index = 1; index <= clicks; index++) {
        CGEventRef down = CGEventCreateMouseEvent(nullptr, right ? kCGEventRightMouseDown : kCGEventLeftMouseDown, location, button);
        CGEventRef up = CGEventCreateMouseEvent(nullptr, right ? kCGEventRightMouseUp : kCGEventLeftMouseUp, location, button);
        if (!down || !up) {
            if (down) CFRelease(down);
            if (up) CFRelease(up);
            return false;
        }
        CGEventSetIntegerValueField(down, kCGMouseEventClickState, index);
        CGEventSetIntegerValueField(up, kCGMouseEventClickState, index);
        CGEventPost(kCGHIDEventTap, down);
        CGEventPost(kCGHIDEventTap, up);
        CFRelease(down);
        CFRelease(up);
    }
    return true;
}

static bool key(CGKeyCode code, CGEventFlags flags, NSString *text) {
    CGEventRef down = CGEventCreateKeyboardEvent(nullptr, code, true);
    CGEventRef up = CGEventCreateKeyboardEvent(nullptr, code, false);
    if (!down || !up) {
        if (down) CFRelease(down);
        if (up) CFRelease(up);
        return false;
    }
    if (text) {
        unichar unit[16] = {};
        NSUInteger length = MIN(text.length, 16);
        [text getCharacters:unit range:NSMakeRange(0, length)];
        CGEventKeyboardSetUnicodeString(down, length, unit);
        CGEventKeyboardSetUnicodeString(up, length, unit);
    }
    CGEventSetFlags(down, flags);
    CGEventSetFlags(up, flags);
    CGEventPost(kCGHIDEventTap, down);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(down);
    CFRelease(up);
    return true;
}

static NSDictionary *run(NSDictionary *input) {
    NSString *operation = input[@"operation"];
    if ([operation isEqualToString:@"clipboard_files"]) {
        NSPasteboard *clipboard = NSPasteboard.generalPasteboard;
        NSMutableOrderedSet<NSString *> *paths = [NSMutableOrderedSet orderedSet];
        for (NSPasteboardItem *item in clipboard.pasteboardItems) {
            NSString *value = [item stringForType:NSPasteboardTypeFileURL];
            if (!value) continue;
            NSURL *url = [NSURL URLWithString:value];
            if (url.isFileURL && url.path.length && (!url.host.length || [url.host isEqualToString:@"localhost"])) {
                [paths addObject:url.path];
            }
        }
        id legacy = [clipboard propertyListForType:@"NSFilenamesPboardType"];
        if ([legacy isKindOfClass:NSArray.class]) {
            for (id path in legacy) if ([path isKindOfClass:NSString.class] && [path isAbsolutePath]) [paths addObject:path];
        }
        return @{ @"paths": paths.array };
    }
    __block NSRunningApplication *front;
    if (NSThread.isMainThread) front = NSWorkspace.sharedWorkspace.frontmostApplication;
    else dispatch_sync(dispatch_get_main_queue(), ^{ front = NSWorkspace.sharedWorkspace.frontmostApplication; });
    if ([operation isEqualToString:@"request_screen"]) return @{ @"granted": @(CGRequestScreenCaptureAccess()) };
    if ([operation isEqualToString:@"frontmost"]) return appInfo(front);
    if ([operation isEqualToString:@"applications"]) {
        NSMutableArray *apps = [NSMutableArray array];
        for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
            if (app.activationPolicy == NSApplicationActivationPolicyRegular) [apps addObject:appInfo(app)];
        }
        return @{ @"frontmost": appInfo(front), @"applications": apps };
    }
    if ([operation isEqualToString:@"focus"]) {
        NSString *bundle = input[@"bundleId"];
        NSRunningApplication *app = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundle].firstObject;
        if (app && [app activateWithOptions:0]) return appInfo(app);
        return @{ @"error": @"The application is not running or did not activate." };
    }
    if (!AXIsProcessTrusted()) return @{ @"error": @"Grant Rainbow Mates Accessibility access in macOS System Settings." };
    if ([operation isEqualToString:@"inspect"]) {
        if (!front) return @{ @"error": @"No foreground application." };
        AXUIElementRef application = AXUIElementCreateApplication(front.processIdentifier);
        AXUIElementSetMessagingTimeout(application, 0.12f);
        id focused = attribute(application, kAXFocusedWindowAttribute);
        NSMutableArray *rows = [NSMutableArray array];
        elements = [NSMutableArray array];
        observedPid = front.processIdentifier;
        AXUIElementRef root = focused ? (__bridge AXUIElementRef)focused : application;
        inspect(root, 0, NSDate.timeIntervalSinceReferenceDate + 0.7, rows);
        CFRelease(application);
        return @{ @"frontmost": appInfo(front), @"elements": rows };
    }
    if (input[@"pid"] && front.processIdentifier != [input[@"pid"] intValue]) {
        return @{ @"error": @"The foreground application changed. Observe it again before sending input." };
    }
    bool success = false;
    if ([operation isEqualToString:@"element"]) {
        NSUInteger index = [input[@"id"] unsignedIntegerValue];
        if (!index || index > elements.count || observedPid != front.processIdentifier) return @{ @"error": @"Inspect the current window before using an element ID." };
        AXUIElementRef element = (__bridge AXUIElementRef)elements[index - 1];
        if ([input[@"action"] isEqualToString:@"focus"]) {
            success = AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue) == kAXErrorSuccess;
        } else {
            success = AXUIElementPerformAction(element, kAXPressAction) == kAXErrorSuccess;
            if (!success) {
                CGPoint point;
                CGSize size;
                success = geometry(element, &point, &size) && size.width > 0 && size.height > 0
                    && click(CGPointMake(point.x + size.width / 2, point.y + size.height / 2), false, 1);
            }
        }
    } else if ([operation isEqualToString:@"click"]) {
        success = click(CGPointMake([input[@"x"] doubleValue], [input[@"y"] doubleValue]), [input[@"right"] boolValue], [input[@"clicks"] intValue]);
    } else if ([operation isEqualToString:@"key"]) {
        success = key([input[@"code"] unsignedShortValue], [input[@"flags"] unsignedLongLongValue], nil);
    } else if ([operation isEqualToString:@"text"]) {
        NSString *text = input[@"text"];
        __block bool sent = true;
        [text enumerateSubstringsInRange:NSMakeRange(0, text.length) options:NSStringEnumerationByComposedCharacterSequences
            usingBlock:^(NSString *substring, NSRange range, NSRange enclosing, BOOL *stop) {
                if (substring.length > 16 || !key(0, 0, substring)) { sent = false; *stop = YES; }
            }];
        success = sent;
    } else if ([operation isEqualToString:@"scroll"]) {
        CGEventRef event = CGEventCreateScrollWheelEvent(nullptr, kCGScrollEventUnitPixel, 2, -[input[@"dy"] intValue], -[input[@"dx"] intValue]);
        if (event) { CGEventPost(kCGHIDEventTap, event); CFRelease(event); success = true; }
    }
    return success ? @{ @"ok": @YES } : @{ @"error": @"macOS could not apply that desktop action." };
}

static NSDictionary *readInput(napi_env env, napi_callback_info info) {
    size_t argc = 1, length = 0;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || !argc
        || napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok || length > 24000) {
        napi_throw_type_error(env, nullptr, "Expected one desktop action.");
        return nil;
    }
    std::vector<char> bytes(length + 1);
    napi_get_value_string_utf8(env, argv[0], bytes.data(), bytes.size(), nullptr);
    id input = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:bytes.data() length:length] options:0 error:nil];
    if ([input isKindOfClass:NSDictionary.class]) return input;
    napi_throw_type_error(env, nullptr, "Invalid desktop action.");
    return nil;
}

static NSData *runAction(NSDictionary *input) {
    NSDictionary *result;
    @try { result = run(input); }
    @catch (NSException *error) { result = @{ @"error": error.reason ?: @"Desktop action failed." }; }
    return [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
}

static napi_value toString(napi_env env, NSData *output) {
    napi_value result;
    if (output) napi_create_string_utf8(env, static_cast<const char *>(output.bytes), output.length, &result);
    else napi_create_string_utf8(env, "{\"error\":\"Invalid desktop response.\"}", NAPI_AUTO_LENGTH, &result);
    return result;
}

static napi_value runJSON(napi_env env, napi_callback_info info) {
    @autoreleasepool {
        NSDictionary *input = readInput(env, info);
        if (!input) return nullptr;
        return toString(env, runAction(input));
    }
}

struct AccessibilityWork {
    NSDictionary *input;
    NSData *output;
    napi_deferred deferred;
    napi_async_work work;
};

// AX requests can target this Electron process and need its UI thread to remain free.
static napi_value runAccessibility(napi_env env, napi_callback_info info) {
    @autoreleasepool {
        NSDictionary *input = readInput(env, info);
        if (!input) return nullptr;
        auto *action = new AccessibilityWork{input, nil, nullptr, nullptr};
        napi_value promise, name;
        napi_create_promise(env, &action->deferred, &promise);
        napi_create_string_utf8(env, "RainbowAccessibility", NAPI_AUTO_LENGTH, &name);
        napi_status status = napi_create_async_work(env, nullptr, name, [](napi_env, void *data) {
            @autoreleasepool {
                auto *action = static_cast<AccessibilityWork *>(data);
                action->output = runAction(action->input);
            }
        }, [](napi_env env, napi_status status, void *data) {
            auto *action = static_cast<AccessibilityWork *>(data);
            napi_resolve_deferred(env, action->deferred, toString(env, status == napi_ok ? action->output : nil));
            napi_delete_async_work(env, action->work);
            delete action;
        }, action, &action->work);
        if (status == napi_ok) status = napi_queue_async_work(env, action->work);
        if (status != napi_ok) {
            if (action->work) napi_delete_async_work(env, action->work);
            delete action;
            napi_throw_error(env, nullptr, "Could not start Accessibility action.");
            return nullptr;
        }
        return promise;
    }
}

NAPI_MODULE_INIT() {
    napi_value action;
    napi_create_function(env, "run", NAPI_AUTO_LENGTH, runJSON, nullptr, &action);
    napi_set_named_property(env, exports, "run", action);
    napi_create_function(env, "accessibility", NAPI_AUTO_LENGTH, runAccessibility, nullptr, &action);
    napi_set_named_property(env, exports, "accessibility", action);
    return exports;
}
