---
name: rho-person-files
description: Open and edit files from the selected project folder while respecting project scope.
---

# Rho person files

A person opens a folder themselves; an Agent is not required to read it.

1. project.entries lists one level of a folder inside the project, bounded and
   confined to the folder it names, skipping owner state and symbolic links. Pass
   path to descend; ".." and absolute paths are refused. The project folder also
   lists the source folders it works in as @<sourceId> entries, and those descend
   the same way, so a project made from source folders is not an empty listing.
2. project.openFile opens one text file as a document and places a single editor
   view for it in the tab layout. Opening the same file again folds into one view.
3. A file the person opened is a document in the shared buffer: they and the Agent
   edit and conditionally save the same text.

The boundary is deliberate and worth stating to a person who asks: a tab may read
its folder, edit a buffer and conditionally save it; it may not register resources, run
anything or reach a sibling project. Those stay Agent or operator work. When a
person expects otherwise, say which rule refuses them rather than reporting a bug.

Files the project shows as registered are not the same as files in the folder: the
sidebar counts registered resources, while the Overview lists the folder itself.
