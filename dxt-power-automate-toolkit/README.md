# DXT Power Automate Toolkit

Local development toolkit for Power Automate solutions at Prepay Power / DTA team.

## Features

- **Browse environments & solutions** — connect to your Power Platform environment and see all solutions
- **Export & unpack** — download a solution from the cloud and unpack it to editable JSON files
- **Pack & import** — pack your local changes back and deploy to the environment
- **Flow Visualizer** — open any flow as an interactive diagram; edit actions, add/delete steps, and insert conditions or loops without touching JSON
- **Action Library** — browse and search all connectors and operations used across your org's flows, with real usage examples
- **Claude AI context** — automatically generates a `CLAUDE.md` in your solutions folder so Claude Code understands your flows and connectors out of the box

## Requirements

- [Power Platform CLI (`pac`)](https://learn.microsoft.com/en-us/power-platform/developer/cli/introduction) installed and authenticated
- VS Code 1.120+

## Getting started

1. Install the extension from the `.vsix` file
2. Click the **Power Automate Toolkit** icon in the activity bar
3. Select your environment from the list
4. Right-click a solution → **Export & Unpack**
5. Open a flow → **Visualize Flow**

## Using with Claude Code

After exporting solutions, click **Build Library** in the Action Library panel. This indexes all your connectors and generates a `CLAUDE.md` in your solutions folder. Open that folder in Claude Code and Claude will automatically understand your flow structure and available connectors.
