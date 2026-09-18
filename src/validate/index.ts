/**
 * Standard Schema validation of fetched items (see docs/delivery.md).
 * @module
 */

export {
  type InvalidItem,
  normalizeIssues,
  parseWith,
  type ValidationIssue,
  validateItems,
} from './validate.ts';
