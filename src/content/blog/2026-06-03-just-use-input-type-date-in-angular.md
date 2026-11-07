---
templateKey: 'blog-post'
title: 'Just use <input type="date">: a date control for Angular without a library'
date: 2026-06-03T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 3
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

When an Angular form needs a date, the reflex is to install a datepicker from Angular Material, PrimeNG or another library. The native [`<input type="date">`](https://developer.mozilla.org/docs/Web/HTML/Reference/Elements/input/date) is right there, but we worry about it: can we style it, will it look wrong in dark mode, which format will it show?

In this article, we build a date field on the native control, style it like every other input, make its calendar dark on a dark page, bind it to reactive forms with signals, and see why a date range works better as two fields than as one calendar.


## What a datepicker really is
A correct date picker is not a popup with a grid in it. As the [ARIA date picker example](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/) shows, it needs a month grid with roving focus and arrow keys that cross week and month boundaries, `PageUp`/`PageDown` paging, locale-aware month and weekday names and **first day of the week**, `min`/`max` with out-of-range days unreachable, an announcement on every move, and, on a phone, something better than a 320px-wide grid of 7×6 tap targets.

That is several hundred lines with a long tail of defects. In the code base this article comes from, the question came up while PrimeNG was being removed: `p-datepicker` was the last component left, with exactly one call site, a "Created between" filter.

With `<input type="date">`, all of that is the browser's job: a native wheel on iOS and Android, and a real form control under a screen reader. A custom picker would have to be *better* than the platform's to be worth it, and on accessibility and mobile input it starts behind.


## What it costs
- **The popup cannot be styled.** Chrome's calendar and Safari's wheel are drawn by the browser; no CSS reaches inside. You can style the *field* and tell the browser which colour scheme to use.
- **The displayed format follows the browser and OS locale**, not the app's language. A French UI in an `en-GB` browser shows `13/09/2026`; in `en-US`, `09/13/2026`. That is defensible: the date format belongs to the reader's machine, and the picker spells the month out anyway.
- **The picker icon differs per browser**, and **not every browser offers a clear button**, so add your own where it matters.

If you need a range highlighted across a grid, a time component or several months side by side, the decision goes the other way. For "pick a day", it does not.


## Style the field with a directive
The field should look like every other text input. A directive on the native element, rather than a component, keeps `type`, `disabled`, `min`, `max` and `formControlName` where the platform put them. Here is `InputDirective`, abridged:

```typescript
@Directive({
  selector: 'input[uiInput], textarea[uiInput], select[uiInput]',
  host: { '[class]': 'classes()' },
})
export class InputDirective {
  public readonly size = input<InputSize>('normal');

  private static readonly BASE = [
    'block w-full rounded-md border bg-(--blouppy-bg) text-(--blouppy-text) border-(--blouppy-border)',
    'focus-visible:outline-2 focus-visible:outline-(--blouppy-focus-ring-color)',
    'aria-[invalid=true]:border-(--blouppy-danger-border)',
    // ... hover, disabled
  ].join(' ');

  private static readonly SIZES: Record<InputSize, string> = { small: 'px-2.5 py-1.5 text-xs', normal: 'px-3 py-2 text-sm' };

  protected readonly classes = computed(() => `${InputDirective.BASE} ${InputDirective.SIZES[this.size()]}`);
}
```

- The colours are CSS variables (design tokens) in Tailwind CSS 4's [`bg-(--token)`](https://tailwindcss.com/docs/background-color) syntax, so a theme switch repaints the field.
- The invalid state is driven by [`aria-invalid`](https://developer.mozilla.org/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-invalid), so what tells a screen reader and what colours the border cannot disagree.


## A dark calendar with color-scheme
CSS cannot reach the popup, but the browser's own chrome does listen to [`color-scheme`](https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/color-scheme). Without it, a dark page gets a dark calendar glyph on a dark field, and a white popup. Declare it once, next to the tokens:

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

The theme service sets the `.dark` class on the root element. The value is page-wide, so the date field, the scrollbars and the native selects all follow, with nothing to repeat per field.


## The one bug magnet: Date ⇄ yyyy-MM-dd
The native value is a zoneless ISO date, `yyyy-MM-dd`; forms want a `Date` at local midnight. Written the obvious way, the conversion is off by one day:

- `new Date('2026-09-13')` is parsed as **UTC** midnight ([MDN](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Date/Date)), so in New York it is the 12th.
- `date.toISOString().slice(0, 10)` converts **to** UTC, so a local midnight in Paris comes back as the previous day.

`date-value.ts` goes through the local calendar fields in both directions:

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

An empty or half-typed box gives `null`, and the last check rejects a date JavaScript would silently roll into the next month.


## The date field component
A small component implementing [`ControlValueAccessor`](https://angular.dev/api/forms/ControlValueAccessor) binds a date like any other control (trimmed):

```typescript
@Component({
  selector: 'ui-date-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  // onBlur, registerOnChange and registerOnTouched are the usual one-liners.
}
```

- `min` and `max` are `Date` inputs converted with the same helper, so the browser greys out everything outside the bounds.
- The value is a [`model()`](https://angular.dev/guide/signals/model) *and* a form control: a form writes it through `writeValue`, and another component can bind `[value]` / `(valueChange)` directly.
- Nothing here formats a date for display: the native control does, following the browser locale.


## Use it in a reactive form
A personal access token can expire on a custom date, between tomorrow and a year from today. The [reactive form](https://angular.dev/guide/forms/reactive-forms) holds a `Date` (`customDate: new FormControl<Date | null>(null, [customDateInRange])`), and the bounds are local midnights built by a `startOfDayIn(days)` helper with `new Date(year, month, day + days)`:

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

- The control holds a `Date`, never a string.
- `[min]` and `[max]` make out-of-range days unreachable; the `customDateInRange` validator still checks them, because a typed year can land outside.
- [`toSignal`](https://angular.dev/api/core/rxjs-interop/toSignal) over `valueChanges` lets a `computed()` show "expires on…" under the field as the reader picks a day.


## Why a range is two fields
The other call site is an audit log filter: "between this day and that day". The tempting answer is a range calendar with two highlighted ends. But a range calendar is a **mode**: the first click means "start", the second means "end", and changing only the end means starting over.

Two boxes have no mode. Either bound is edited on its own, either may stay open ("everything before the 30th" is one field), and they are one Tab apart. At a narrow width they stack, which a month grid cannot do. Here is the heart of `DateRangeComponent`, whose value is `readonly [Date | null, Date | null]`:

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

- The value is always a pair: `[null, null]` means "no range", so there is no second empty case.
- The start is the end's `min` and the end is the start's `max`: an end before the start is unreachable.
- The inner fields are bound by value, not `ngModel`, which writes one microtask late and would leave the boxes a frame behind.
- `showClear` adds the component's own clear button.

In the filter bar it binds like any control: `<ui-date-range [showClear]="true" [ngModel]="state().range" (ngModelChange)="onRangeChange($event)" />`.


## Conclusion
The native `<input type="date">` gives you the keyboard, the locale, the screen-reader announcements and the mobile wheel for free. It needs only a directive for its look, one `color-scheme` rule and a time-zone-safe conversion; a `ControlValueAccessor` joins it to forms, and a range becomes two fields that constrain each other.

The date fields of [Blouppy Starter](https://starter.blouppy.com/) are built this way, as part of its [design system](https://docs.starter.blouppy.com/choices/design-system/).


## References

- [`<input type="date">`](https://developer.mozilla.org/docs/Web/HTML/Reference/Elements/input/date) — MDN: the value format, `min`/`max` and browser support.
- [`color-scheme`](https://developer.mozilla.org/docs/Web/CSS/Reference/Properties/color-scheme) — MDN: telling the browser which scheme its own controls use.
- [`Date()` constructor](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Date/Date) — MDN: why a date-only string is parsed as UTC.
- [Date picker dialog example](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/) — WAI-ARIA Authoring Practices: what a custom picker must implement.
- [`aria-invalid`](https://developer.mozilla.org/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-invalid) — MDN: announcing an invalid field.
- [ControlValueAccessor](https://angular.dev/api/forms/ControlValueAccessor) and [Reactive forms](https://angular.dev/guide/forms/reactive-forms) — angular.dev: custom form controls.
- [Model inputs](https://angular.dev/guide/signals/model) and [`toSignal`](https://angular.dev/api/core/rxjs-interop/toSignal) — angular.dev: two-way signal binding and observables as signals.
- [Tailwind CSS background color](https://tailwindcss.com/docs/background-color) — the `bg-(--token)` CSS variable syntax.
- [Design system in Blouppy Starter](https://docs.starter.blouppy.com/choices/design-system/) — the Starter's documentation of its UI library.
