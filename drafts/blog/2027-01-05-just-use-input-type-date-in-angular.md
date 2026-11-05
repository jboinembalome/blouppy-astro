---
templateKey: 'blog-post'
title: 'Just use <input type="date">: a date control for Angular without a library'
date: 2027-01-05T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/just-use-input-type-date-in-angular.jpg
description: >-
  Learn how to build an accessible, mobile-friendly date field in Angular on the native input, with dark mode, min/max, reactive forms and a date range.
tags:
  - Development
  - Angular
  - TypeScript
  - Accessibility
  - Forms
---

When an Angular form needs a date, the reflex is to install a datepicker: Angular Material, PrimeNG, or something else. The native `<input type="date">` is right there, but we worry about it: can we style it? Will it look wrong in dark mode? Which format will it show?

In this article, we will build a date field on the native control, style it like every other input, make its calendar dark on a dark page, bind it to reactive forms with signals, and see why a date range is better as two fields than as one calendar.


## What a datepicker really is
A correct date picker is not a popup with a grid in it. Here is what it has to do:

- a month grid with roving focus, and arrow keys that cross week and month boundaries;
- `PageUp` / `PageDown` to page by month, with `Shift` for years;
- locale-aware month names, weekday abbreviations and **first day of the week**;
- `min` / `max`, with the out-of-range days unreachable rather than merely grey;
- an announcement on every move that says the date, the weekday and whether it is selectable;
- and, on a phone, something better than a 320px-wide grid of 7×6 tap targets.

That is several hundred lines with a long tail of defects. In the code base this article comes from, the question came up while PrimeNG was being removed: `p-datepicker` was the last component left, and it had exactly one call site, a "Created between" filter.

With `<input type="date">`, every bullet above becomes the browser's job. On iOS and Android, the reader gets a native wheel. Under a screen reader, the field is announced as a real form control, it takes part in validation and it honours `min`/`max`, even with a screen reader we never tested.

> **_Note:_**  A custom picker would have to be *better* than the platform's to be worth it. On screen-reader support and mobile input, it would start behind and stay there. The only thing it wins is the look of a panel that is on screen for four seconds. 😉


## What it costs
Let's be honest about the trade-off:

- **The popup cannot be styled.** Chrome's calendar and Safari's wheel are drawn by the browser; no CSS reaches inside. We can style the *field* (border, radius, focus ring), and we will tell the browser which scheme to use.
- **The displayed format follows the browser/OS locale**, not the app's language. A French UI in an `en-GB` browser shows `13/09/2026`; in `en-US`, `09/13/2026`. That is arguably right: the date format is a property of the reader's machine, not of the copy they read. The picker itself spells the month out anyway.
- **The icon that opens the picker differs per browser** and cannot be replaced. It is a well-known affordance.
- **Firefox and Safari differ on whether they offer a clear button.** We will add our own where it matters.

If we needed a range highlighted across a grid, a time component, or several months side by side, the decision would go the other way. For "pick a day", it does not.


## Style the field with a directive
The field should look like every other text input. Instead of a component, let's use a directive on the native element, so `type`, `disabled`, `min`, `max` and `formControlName` stay where the platform put them. Here is a simplified version of the `InputDirective`:

```typescript
@Directive({
  selector: 'input[uiInput], textarea[uiInput], select[uiInput]',
  host: { '[class]': 'classes()' },
})
export class InputDirective {
  public readonly size = input<InputSize>('normal');

  private static readonly BASE = [
    'block w-full rounded-md border bg-(--blouppy-bg) text-(--blouppy-text)',
    'border-(--blouppy-border) hover:border-(--blouppy-surface-400)',
    'focus-visible:border-(--blouppy-focus-ring-color) focus-visible:outline-2 focus-visible:outline-(--blouppy-focus-ring-color)',
    'disabled:cursor-not-allowed disabled:opacity-60',
    'aria-[invalid=true]:border-(--blouppy-danger-border)',
  ].join(' ');

  private static readonly SIZES: Record<InputSize, string> = {
    small: 'px-2.5 py-1.5 text-xs',
    normal: 'px-3 py-2 text-sm',
  };

  protected readonly classes = computed(() => `${InputDirective.BASE} ${InputDirective.SIZES[this.size()]}`);
}
```

- The colours are CSS variables (design tokens), written with Tailwind CSS 4's `bg-(--token)` syntax, so a theme switch repaints the field.
- The invalid state is driven by `aria-invalid`, not by a separate input. The thing that tells a screen reader and the thing that colours the border cannot disagree.


## A dark calendar with color-scheme
Now the dark mode problem. Our CSS cannot reach the popup, but there is one thing the browser's chrome *does* listen to: `color-scheme`. Without it, a dark page gets a dark calendar glyph on a dark field, and a white popup.

Let's declare it once, next to the tokens, in `tokens.css`:

```css
:root {
  /* Scrollbars, native selects, the date picker's calendar and every other
   * piece of chrome the browser draws itself follow this. */
  color-scheme: light;
}

.dark {
  color-scheme: dark;
}
```

The `.dark` class is set on the root element by the theme service. Because the value is page-wide, the date field inherits it, and the scrollbars and native selects follow too.

> **_Note:_**  The field used to set `scheme-light dark:scheme-dark` on itself. Moving the rule to `:root` and `.dark` fixed every native control at once, so nothing is left to repeat per field. 👍


## The one bug magnet: Date ⇄ yyyy-MM-dd
The native value is a zoneless ISO date, `yyyy-MM-dd`. Our forms want a `Date` at local midnight. Written the obvious way, the conversion is off by one day:

- `new Date('2026-09-13')` is parsed as **UTC** midnight, so west of Greenwich it shows as the 12th.
- `date.toISOString().slice(0, 10)` converts **to** UTC, so a local midnight east of Greenwich comes back as the previous day.

Here is `date-value.ts`, which goes through the local calendar fields in both directions:

```typescript
export function toDateInputValue(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) {
    return '';
  }

  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');

  return `${date.getFullYear()}-${month}-${day}`;
}

export function fromDateInputValue(value: string): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!parts) {
    return null;
  }

  const [, year, month, day] = parts;
  const date = new Date(Number(year), Number(month) - 1, Number(day));

  // `new Date(2026, 1, 31)` is quietly the 3rd of March.
  return date.getMonth() === Number(month) - 1 && date.getDate() === Number(day) ? date : null;
}
```

An empty or half-typed box gives `null`, and the last check rejects a date JavaScript would silently roll over into the next month.


## The date field component
Now let's wrap the input in a small component that implements `ControlValueAccessor`, so a date is bound like any other control. Here is a trimmed `DateFieldComponent`:

```typescript
@Component({
  selector: 'ui-date-field',
  imports: [InputDirective],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => DateFieldComponent), multi: true }],
  template: `
    <input
      type="date"
      uiInput
      [id]="inputId() || null"
      [disabled]="isDisabled()"
      [value]="text()"
      [attr.min]="bound(min())"
      [attr.max]="bound(max())"
      [attr.aria-invalid]="invalid() || null"
      (input)="onInput($event)"
      (blur)="onBlur()" />
  `,
})
export class DateFieldComponent implements ControlValueAccessor {
  public readonly inputId = input<string>();
  public readonly invalid = input(false);
  public readonly disabled = input(false);
  public readonly min = input<Date | null>(null);
  public readonly max = input<Date | null>(null);
  public readonly value = model<Date | null>(null);

  private readonly _disabledByForm = signal(false);
  protected readonly isDisabled = computed(() => this.disabled() || this._disabledByForm());
  protected readonly text = computed(() => toDateInputValue(this.value()));

  private _onChange: (value: Date | null) => void = () => undefined;
  private _onTouched: () => void = () => undefined;

  protected bound(date: Date | null): string | null {
    return toDateInputValue(date) || null;
  }

  protected onInput(event: Event): void {
    const date = fromDateInputValue((event.target as HTMLInputElement).value);

    this.value.set(date);
    this._onChange(date);
  }

  public writeValue(value: Date | null): void {
    this.value.set(value ?? null);
  }

  public setDisabledState(isDisabled: boolean): void {
    this._disabledByForm.set(isDisabled);
  }

  // registerOnChange, registerOnTouched and onBlur are the usual one-liners.
}
```

- `min` and `max` are `Date` inputs, converted with the same helper, so the browser greys out everything outside the bounds.
- The value is a `model()` *and* a form control. A form writes it through `writeValue`; another component can bind `[value]` / `(valueChange)` directly.
- Nothing here formats a date for display. The native control does it, following the browser locale.


## Use it in a reactive form
Let's look at a real call site: a personal access token can expire on a custom date, between tomorrow and a year from today. First, the form and the bounds:

```typescript
function startOfDayIn(days: number): Date {
  const today = new Date();

  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
}

public readonly tokenForm = new FormGroup({
  // ...
  customDate: new FormControl<Date | null>(null, [customDateInRange]),
});

protected readonly earliestCustomDate = startOfDayIn(1);
protected readonly latestCustomDate = startOfDayIn(PERSONAL_ACCESS_TOKEN_RULES.maxLifetimeInDays);
```

And the template:

```html
<ui-form-field [label]="'account.security.tokens.customDate' | transloco" for="personalAccessTokenCustomDate" [required]="true">
  <ui-date-field
    inputId="personalAccessTokenCustomDate"
    formControlName="customDate"
    class="block w-full sm:w-64"
    [min]="earliestCustomDate"
    [max]="latestCustomDate"
    [invalid]="isInvalid('customDate')" />
</ui-form-field>
```

- `formControlName` works because the component is a `ControlValueAccessor`; the control holds a `Date`, never a string.
- `[min]` and `[max]` make out-of-range days unreachable in the picker.
- The `customDateInRange` validator still checks the same bounds, because a browser that lets the year be typed freely can still produce a date outside them.

The component also turns the form's value into a signal with `toSignal(this.tokenForm.valueChanges.pipe(startWith(this.tokenForm.value)))`, so a `computed()` can show "expires on…" under the field as the reader picks a day.


## Why a range is two fields
The other call site is an audit log filter: "between this day and that day". The tempting answer is a range calendar with two highlighted ends. But a range calendar is a **mode**: the first click means "start", the second means "end", and changing only the end means starting the gesture over.

Two boxes have no mode. Either bound is edited on its own, either may be left open ("everything before the 30th" is one field and no gesture), and both are one Tab apart. At a narrow width they stack, which a month grid cannot do.

Here is the heart of `DateRangeComponent`:

```typescript
export type UiDateRange = readonly [Date | null, Date | null];
```

```html
<div class="flex flex-wrap items-end gap-2" role="group" [attr.aria-labelledby]="ariaLabelledby() || null">
  <div class="flex min-w-32 flex-1 basis-32 flex-col gap-1">
    <label [for]="fromId()">{{ text().from }}</label>
    <ui-date-field [inputId]="fromId()" [max]="to()" [value]="from()" (valueChange)="setBound(0, $event)" />
  </div>

  <div class="flex min-w-32 flex-1 basis-32 flex-col gap-1">
    <label [for]="toId()">{{ text().to }}</label>
    <ui-date-field [inputId]="toId()" [min]="from()" [value]="to()" (valueChange)="setBound(1, $event)" />
  </div>
</div>
```

- The value is always a pair, never `null` for "no range": `[null, null]` already says it, so no call site has to handle a second empty case.
- The start is the end's `min`, and the end is the start's `max`. An end before the start is unreachable in the picker instead of rejected afterwards.
- The inner fields are bound by value rather than with `ngModel`, which writes one microtask late and would leave the boxes a frame behind the outer form.
- The component adds its own clear button (`showClear`), so clearing never depends on the browser.

In the filter bar, it is bound like any control: `<ui-date-range [showClear]="true" [ngModel]="state().range" (ngModelChange)="onRangeChange($event)" />`.


## Conclusion
The native `<input type="date">` gives us the keyboard, the locale's month names, the first day of the week, the screen-reader announcements and the mobile wheel for free. What it does not give us is small: a directive for the field's look, one `color-scheme` rule on `:root` and `.dark` for a dark calendar, and a careful `Date` ⇄ `yyyy-MM-dd` conversion that does not lose a day across time zones.

On top of that, a `ControlValueAccessor` lets the field join reactive forms, `min`/`max` make invalid days unreachable, and a range becomes two independent fields that constrain each other instead of a calendar with a mode.

This is how the date fields are built in [Blouppy Starter](https://starter.blouppy.com/), where the reasoning sits next to the rest of its [design system choices](https://docs.starter.blouppy.com/choices/design-system/).

*Thanks for reading! 🙂*
