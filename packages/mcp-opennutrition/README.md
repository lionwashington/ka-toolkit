# MCP OpenNutrition

A Model Context Protocol (MCP) server providing access to the comprehensive OpenNutrition food database with 300,000+ food items, nutritional data, and barcode lookups.

OpenNutrition addresses the longstanding issues with fragmented and unreliable nutritional data by combining authoritative public sources (USDA, CNF, FRIDA, AUSNUT). Unlike other databases that suffer from inconsistent user-generated content or restrictive commercial licensing, OpenNutrition provides transparent, comprehensive, and accurate nutritional data that's freely accessible to developers and researchers.

## Tools

- **Search by Name**: Find foods by name, brand, or partial matches
- **Browse Foods**: Get paginated lists of all available foods
- **Get by ID**: Retrieve detailed nutritional information using food IDs
- **Barcode Lookup**: Find foods using EAN-13 barcodes

## Installation

### Docker (recommended)

The easiest way to run the server is via Docker. No build steps required.

Run the container:
```bash
docker run --rm -p 9113:3000 deadletterq/mcp-opennutrition
```

Then add to your MCP configuration:
```json
"mcp-opennutrition": {
    "type": "streamable-http",
    "url": "http://localhost:9113"
}
```

### From source

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the project:
   ```bash
   npm run build
   ```

3. Add to your MCP configuration (set the same version of node that you used to build the project):
   ```json
   "mcp-opennutrition": {
       "command": "/Users/YOUR.USERNAME/.nvm/versions/node/v20.19.0/bin/node",
       "args": [
           "/ABSOLUTE/PATH/TO/PARENT/FOLDER/mcp-opennutrition/build/index.js"
       ]
   }
   ```

## Data Source

This server uses the [OpenNutrition dataset](https://www.opennutrition.app/).

The dataset provides comprehensive nutritional profiles including macronutrients, vitamins, and minerals.

### Obtaining the dataset

The dataset archive (~60 MB) is **not committed to this repo**. Before building, download
`opennutrition-dataset-2025.1.zip` from <https://www.opennutrition.app/> and place it at:

```
packages/mcp-opennutrition/data/opennutrition-dataset-2025.1.zip
```

`npm run build` (via `convert-data`) decompresses it and builds the local SQLite database.
The dataset is licensed under DbCL / ODbL — see `data/LICENSE-DbCL.txt` and `data/LICENSE-ODbL.txt`,
and attribute "OpenNutrition" (https://www.opennutrition.app) as those licenses require.

## Usage

Once configured, the MCP server runs fully locally on your machine and automatically provides food and nutrition query capabilities to Claude/Cline. All data processing and queries happen locally with no external API calls, ensuring privacy and fast response times.

## Example

Here is an example of how Claude uses the tool for a brownie recipe:

![Brownie Recipe Example](readme_example.png)
