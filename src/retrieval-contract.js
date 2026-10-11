import { createHash } from 'node:crypto'

// Only adapter-owned JSON crosses this boundary, never live Cordis/Session objects.
// Sorted keys give selectors and encoding inputs stable identities after persistence.
function json(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || seen.has(value)) throw new TypeError('Expected finite, acyclic JSON')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Expected a plain JSON object')
  }
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('JSON cannot contain symbol keys')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('JSON cannot contain sparse arrays')
        return json(value[index], seen)
      }))
    }
    return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON cannot contain accessors')
      return [key, json(descriptor.value, seen)]
    })))
  } finally {
    seen.delete(value)
  }
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(label + ' must be a plain object')
  }
  return value
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(label + ' must be a nonempty string')
  return value
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A selector is opaque JSON interpreted by its adapter, always bound to a source revision. */
export function sourceReference(value) {
  record(value, 'Reference')
  const allowed = ['namespace', 'objectId', 'revision', 'componentId', 'selector']
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError('Unknown reference field')
  const reference = {
    namespace: text(value.namespace, 'namespace'),
    objectId: text(value.objectId, 'objectId'),
    revision: text(value.revision, 'revision'),
  }
  if (Object.hasOwn(value, 'componentId')) reference.componentId = text(value.componentId, 'componentId')
  if (Object.hasOwn(value, 'selector')) reference.selector = json(value.selector)
  return Object.freeze(reference)
}

export function referenceKey(reference) {
  return JSON.stringify(sourceReference(reference))
}

/** Source/representation changes invalidate the projection, not compatible encoding bytes. */
export function searchView(value) {
  record(value, 'View')
  record(value.representation, 'Representation')
  if (!Array.isArray(value.sources) || !value.sources.length) throw new TypeError('View requires source references')
  const input = json(value.input)
  const view = {
    namespace: text(value.namespace, 'namespace'),
    id: text(value.id, 'view id'),
    revision: text(value.revision, 'view revision'),
    representation: Object.freeze({
      id: text(value.representation.id, 'representation id'),
      revision: text(value.representation.revision, 'representation revision'),
    }),
    sources: Object.freeze(value.sources.map(sourceReference)),
    input,
    // The embedding spaceId is a separate cache key supplied by the embedding service.
    inputHash: digest(input),
  }
  return Object.freeze({ ...view, projectionHash: digest(view) })
}

const ordered = ['lt', 'lte', 'gt', 'gte']
const scalar = (value, type) => typeof value === type && (type !== 'number' || Number.isFinite(value))

function fieldDescriptors(fields) {
  record(fields, 'Fields')
  return Object.freeze(Object.fromEntries(Object.entries(fields).map(([name, definition]) => {
    text(name, 'field name')
    record(definition, 'Field descriptor')
    if (!['string', 'number', 'boolean'].includes(definition.type)) throw new TypeError('Unsupported field type')
    const supported = ['eq', 'in', ...(definition.type === 'number' ? ordered : [])]
    if (!Array.isArray(definition.operators) || definition.operators.some((op) => !supported.includes(op))) {
      throw new TypeError('Unsupported field operator')
    }
    return [name, Object.freeze({ type: definition.type, operators: Object.freeze([...new Set(definition.operators)]) })]
  })))
}

/** Each row is one adapter-defined component or logical binding, never a bag of unrelated values. */
export function matchBoundFilter({ fields = {}, rows = [], where = [] } = {}) {
  const descriptors = fieldDescriptors(fields)
  if (!Array.isArray(rows) || !Array.isArray(where)) throw new TypeError('Rows and predicates must be arrays')
  const unsupported = []
  const predicates = where.map((predicate) => {
    record(predicate, 'Predicate')
    const field = text(predicate.field, 'predicate field')
    const op = text(predicate.op, 'predicate operator')
    const descriptor = Object.hasOwn(descriptors, field) ? descriptors[field] : undefined
    if (!descriptor?.operators.includes(op)) {
      unsupported.push({ field, op })
      return undefined
    }
    const value = json(predicate.value)
    if (op === 'in' ? !Array.isArray(value) || value.some((entry) => !scalar(entry, descriptor.type)) : !scalar(value, descriptor.type)) {
      throw new TypeError('Predicate value does not match field type')
    }
    return { field, op, value, type: descriptor.type }
  })
  // Validate capabilities before scanning, including when the candidate set is empty.
  if (unsupported.length) return { status: 'unsupported', unsupported, matches: [] }
  const matches = []
  for (const row of rows) {
    record(row, 'Bound row')
    const ref = sourceReference(row.ref)
    const values = json(record(row.values, 'Bound values'))
    // Invalid typed rows must not become ordinary nonmatches through predicate short-circuiting.
    for (const [field, descriptor] of Object.entries(descriptors)) {
      if (Object.hasOwn(values, field) && !scalar(values[field], descriptor.type)) {
        throw new TypeError('Bound value does not match field type')
      }
    }
    const passed = predicates.every(({ field, op, value }) => {
      if (!Object.hasOwn(values, field)) return false
      const actual = values[field]
      if (op === 'eq') return actual === value
      if (op === 'in') return value.includes(actual)
      if (op === 'lt') return actual < value
      if (op === 'lte') return actual <= value
      if (op === 'gt') return actual > value
      return actual >= value
    })
    if (passed) matches.push({ ref, values })
  }
  return { status: matches.length ? 'ok' : 'empty', matches }
}

/** Optional capabilities remain open-ended; no category or model-specific primitive is required. */
export function createAdapter({ id, revision, fields = {}, capabilities } = {}) {
  text(id, 'adapter id')
  text(revision, 'adapter revision')
  record(capabilities, 'Capabilities')
  const methods = Object.fromEntries(Object.entries(capabilities).map(([name, method]) => {
    text(name, 'capability name')
    if (typeof method !== 'function') throw new TypeError('Capability must be a function')
    return [name, method]
  }))
  if (typeof methods.project !== 'function' || typeof methods.resolve !== 'function') {
    throw new TypeError('Adapter requires project and resolve capabilities')
  }
  return Object.freeze({ id, revision, fields: fieldDescriptors(fields), capabilities: Object.freeze(methods) })
}

export async function invokeAdapter(adapter, capability, request) {
  text(capability, 'capability name')
  if (!Object.hasOwn(adapter.capabilities, capability)) return { status: 'unsupported', capability }
  return adapter.capabilities[capability](request)
}
