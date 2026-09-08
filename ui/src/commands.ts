export interface Command {
  id: string;
  label: string;
  group: "File" | "Edit" | "View" | "Session";
  shortcut?: string;
  enabled: () => boolean;
  run: () => void;
}
/** Menus and command search consume the same executable conditions. */
export class Commands {
  entries: Command[] = [];
  execute(id: string) {
    const command = this.entries.find((c) => c.id === id);
    if (command?.enabled()) command.run();
  }
}
