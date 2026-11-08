import type { PreviewTemplateComponentProps } from "decap-cms-core";

type Entry = PreviewTemplateComponentProps["entry"];

// A text field of the entry being edited; empty while it is not filled in.
export const textField = (entry: Entry, name: string): string => {
  const value = entry.getIn(["data", name]);
  return typeof value === "string" ? value : "";
};

// A list field (the tags), as a plain array.
export const listField = (entry: Entry, name: string): string[] => {
  const value = entry.getIn(["data", name]) as { toJS?: () => unknown } | undefined;
  const list = value?.toJS?.();
  return Array.isArray(list) ? list.map(String) : [];
};
