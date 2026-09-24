import { useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  defaultFields,
  fieldLabels,
  moveField,
  widthLimits,
} from "../object-fields";
import type { ObjectField, ObjectFields, WidthField } from "../object-fields";
export function ObjectFieldsMenu({
  config,
  change,
}: {
  config: ObjectFields;
  change(value: ObjectFields): void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="object-fields-trigger">Fields</Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="menu object-fields-popover"
          align="end"
          sideOffset={6}
          collisionPadding={12}
        >
          <Menu.Label className="menu-label">
            Show and arrange columns
          </Menu.Label>
          <div className="object-field-fixed">
            <span>Name</span>
            <small>Always shown</small>
          </div>
          {config.order.map((field, index) => (
            <div className="object-field-option" key={field}>
              <Menu.CheckboxItem
                checked={!config.hidden.includes(field)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(checked) =>
                  change({
                    ...config,
                    hidden: checked
                      ? config.hidden.filter((f) => f !== field)
                      : [...config.hidden, field],
                  })
                }
              >
                <span className="field-checkbox" aria-hidden="true">
                  {!config.hidden.includes(field) ? "✓" : ""}
                </span>
                {fieldLabels[field]}
              </Menu.CheckboxItem>
              <Menu.Item
                asChild
                disabled={index === 0}
                onSelect={(e) => e.preventDefault()}
              >
                <button
                  aria-label={`Move ${fieldLabels[field]} up`}
                  disabled={index === 0}
                  onClick={() =>
                    change(moveField(config, field, config.order[index - 1]))
                  }
                >
                  ↑
                </button>
              </Menu.Item>
              <Menu.Item
                asChild
                disabled={index === config.order.length - 1}
                onSelect={(e) => e.preventDefault()}
              >
                <button
                  aria-label={`Move ${fieldLabels[field]} down`}
                  disabled={index === config.order.length - 1}
                  onClick={() =>
                    change(moveField(config, field, config.order[index + 1]))
                  }
                >
                  ↓
                </button>
              </Menu.Item>
            </div>
          ))}
          <Menu.Separator className="menu-separator" />
          <Menu.Item onSelect={() => change({ ...config, widths: {} })}>
            Fit columns
          </Menu.Item>
          <Menu.Item onSelect={() => change(defaultFields())}>
            Reset fields
          </Menu.Item>
          <div className="object-fields-hint">
            Drag headers to reorder. Drag a divider to resize.
          </div>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
export function DirectoryHeader({
  config,
  change,
  previewWidths,
}: {
  config: ObjectFields;
  change(value: ObjectFields): void;
  previewWidths(value: ObjectFields["widths"] | null): void;
}) {
  const [dragged, setDragged] = useState<ObjectField | null>(null),
    [target, setTarget] = useState<ObjectField | null>(null);
  const resize = useRef<{
    field: WidthField;
    x: number;
    width: number;
    next: number;
    pointer: number;
  } | null>(null);
  const columns: WidthField[] = [
    "name",
    ...config.order.filter((f) => !config.hidden.includes(f)),
  ];
  return (
    <div className="object-column-head" role="row">
      {columns.map((field) => (
        <div
          key={field}
          role="columnheader"
          data-field={field}
          className={`directory-column-header ${target === field ? "drop-target" : ""}`}
          draggable={field !== "name"}
          tabIndex={field === "name" ? -1 : 0}
          onDragStart={(event) => {
            if (field === "name") return;
            setDragged(field);
            event.dataTransfer.setData("application/x-rho-object-field", field);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            if (field !== "name" && dragged) {
              event.preventDefault();
              event.stopPropagation();
              setTarget(field);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (field !== "name" && dragged)
              change(moveField(config, dragged, field));
            setDragged(null);
            setTarget(null);
          }}
          onDragEnd={() => {
            setDragged(null);
            setTarget(null);
          }}
          onKeyDown={(event) => {
            if (
              field === "name" ||
              !event.altKey ||
              !["ArrowLeft", "ArrowRight"].includes(event.key)
            )
              return;
            event.preventDefault();
            const next =
              config.order.indexOf(field) +
              (event.key === "ArrowLeft" ? -1 : 1);
            if (config.order[next])
              change(moveField(config, field, config.order[next]));
          }}
          title={
            field === "name"
              ? "Name stays first"
              : "Drag to reorder; Alt + Arrow Left/Right also moves this field"
          }
        >
          {field === "name" ? "Name" : fieldLabels[field]}
          <span
            role="separator"
            aria-label={`Resize ${field === "name" ? "Name" : fieldLabels[field]} column`}
            aria-orientation="vertical"
            tabIndex={0}
            className="directory-column-resizer"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              const width =
                event.currentTarget.parentElement!.getBoundingClientRect()
                  .width;
              resize.current = {
                field,
                x: event.clientX,
                width,
                next: width,
                pointer: event.pointerId,
              };
            }}
            onPointerMove={(event) => {
              const active = resize.current;
              if (!active || active.pointer !== event.pointerId) return;
              const [min, max] = widthLimits[active.field];
              active.next = Math.round(
                Math.max(
                  min,
                  Math.min(max, active.width + event.clientX - active.x),
                ),
              );
              previewWidths({ ...config.widths, [active.field]: active.next });
            }}
            onPointerUp={(event) => {
              const active = resize.current;
              if (!active) return;
              change({
                ...config,
                widths: { ...config.widths, [active.field]: active.next },
              });
              resize.current = null;
              previewWidths(null);
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              resize.current = null;
              previewWidths(null);
            }}
            onDoubleClick={() => {
              const widths = { ...config.widths };
              delete widths[field];
              change({ ...config, widths });
            }}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const current =
                event.currentTarget.parentElement!.getBoundingClientRect()
                  .width;
              const [min, max] = widthLimits[field];
              change({
                ...config,
                widths: {
                  ...config.widths,
                  [field]: Math.max(
                    min,
                    Math.min(
                      max,
                      current + (event.key === "ArrowLeft" ? -16 : 16),
                    ),
                  ),
                },
              });
            }}
          />
        </div>
      ))}
      <span aria-hidden="true" />
    </div>
  );
}
