// Tools barrel — re-exports each tool factory + buildToolsFromConfig dispatcher.
export { buildEscalateTool } from './escalate.js'
export { buildCollectInfoTool, ALLOWED_FIELDS } from './collect-info.js'
export { buildBusinessHoursTool } from './business-hours.js'
export { buildToolsFromConfig } from './build.js'
