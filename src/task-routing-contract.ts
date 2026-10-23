// Rho-owned control-plane contract: one task assigned to one native binding.
// The native entry points themselves are owner contracts, snapshotted from
// @rho-workspace/plugin-agent in src/contracts/owners.generated.ts; these two
// shapes exist only because this application owns the routing assignment.
export const routeSchemas = {
  RouteInput: {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
    },
    "taskId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
    },
    "expectedVersion": {
      "type": "integer",
      "minimum": 0
    },
    "changeId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
    },
    "compositionId": {
      "type": "string",
      "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
    },
    "participants": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "bindingId": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "role": {
            "enum": [
              "business",
              "presentation"
            ]
          }
        },
        "required": [
          "bindingId",
          "role"
        ]
      },
      "maxItems": 2,
      "minItems": 1
    },
    "feedbackOwnerBindingId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "presenterBindingId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "policyRef": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    }
  },
  "required": [
    "projectId",
    "taskId",
    "expectedVersion",
    "changeId",
    "compositionId",
    "participants",
    "feedbackOwnerBindingId",
    "presenterBindingId",
    "policyRef"
  ]
},
  RouteOutput: {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "current": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "projectId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
        },
        "taskId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
        },
        "version": {
          "type": "integer",
          "minimum": 1
        },
        "compositionId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
        },
        "participants": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "bindingId": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "role": {
                "enum": [
                  "business",
                  "presentation"
                ]
              }
            },
            "required": [
              "bindingId",
              "role"
            ]
          },
          "maxItems": 2,
          "minItems": 1
        },
        "feedbackOwnerBindingId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "presenter": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "bindingId": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "generation": {
                  "type": "integer",
                  "minimum": 1
                }
              },
              "required": [
                "bindingId",
                "generation"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "policyRef": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "projectId",
        "taskId",
        "version",
        "compositionId",
        "participants",
        "feedbackOwnerBindingId",
        "presenter",
        "policyRef"
      ]
    },
    "receipt": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "changeId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
        },
        "requestDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "author": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
        },
        "version": {
          "type": "integer",
          "minimum": 1
        },
        "at": {
          "type": "string",
          "format": "date-time"
        }
      },
      "required": [
        "changeId",
        "requestDigest",
        "author",
        "version",
        "at"
      ]
    }
  },
  "required": [
    "current",
    "receipt"
  ]
}
} as const;
