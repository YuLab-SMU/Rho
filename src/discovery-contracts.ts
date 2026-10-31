// Exact expanded phase0-0.1 profiles. Inert metadata; no implementation import.
export const discoverySchemas: Record<string, any> = {
  "IndexInput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "projectId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "role": {
        "enum": [
          "business",
          "presentation",
          "adapter",
          "browser"
        ]
      },
      "query": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "after": {
            "type": "integer",
            "minimum": 0
          },
          "cursor": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "maxBytes": {
            "type": "integer",
            "minimum": 1024,
            "maximum": 65536
          }
        },
        "required": [
          "after",
          "cursor",
          "limit",
          "maxBytes"
        ]
      }
    },
    "required": [
      "projectId",
      "role",
      "query"
    ]
  },
  "IndexOutput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "catalogRef": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "authorizationRef": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "scopeHint": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "projectId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "taskId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "compositionId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "callerBindingId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "projectId",
          "taskId",
          "compositionId",
          "callerBindingId"
        ]
      },
      "entries": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "owner": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "summary": {
              "type": "string",
              "minLength": 1,
              "maxLength": 240
            },
            "contractRef": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "skillRefs": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "maxItems": 8,
              "minItems": 0
            }
          },
          "required": [
            "id",
            "owner",
            "summary",
            "contractRef",
            "skillRefs"
          ]
        },
        "maxItems": 100,
        "minItems": 0
      },
      "next": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          {
            "type": "null"
          }
        ]
      },
      "complete": {
        "type": "boolean"
      }
    },
    "required": [
      "catalogRef",
      "authorizationRef",
      "scopeHint",
      "entries",
      "next",
      "complete"
    ]
  },
  "ResolveInput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "projectId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "catalogRef": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "selected": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "maxItems": 16,
        "minItems": 1
      },
      "knownRefs": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "maxItems": 128,
        "minItems": 0
      },
      "cursor": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          {
            "type": "null"
          }
        ]
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 1024,
        "maximum": 65536
      }
    },
    "required": [
      "projectId",
      "catalogRef",
      "selected",
      "knownRefs",
      "cursor",
      "maxBytes"
    ]
  },
  "ResolveOutput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "bundleRef": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "ref": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "kind": {
              "enum": [
                "skill",
                "contract"
              ]
            },
            "content": {
              "type": "object"
            }
          },
          "required": [
            "ref",
            "kind",
            "content"
          ]
        },
        "maxItems": 32,
        "minItems": 0
      },
      "omittedKnownRefs": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "maxItems": 128,
        "minItems": 0
      },
      "next": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          {
            "type": "null"
          }
        ]
      },
      "complete": {
        "type": "boolean"
      },
      "requiredBytes": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 1
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "bundleRef",
      "items",
      "omittedKnownRefs",
      "next",
      "complete",
      "requiredBytes"
    ]
  },
  "LayeredConnectionDescriptor": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiVersion": {
        "const": "2.0"
      },
      "url": {
        "type": "string",
        "pattern": "^http://127\\.0\\.0\\.1:[0-9]+$"
      },
      "token": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "projectId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "externalSessionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "methods": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "maxItems": 64,
        "minItems": 0
      },
      "profile": {
        "enum": [
          "layered-business",
          "layered-presentation"
        ]
      },
      "pluginFilter": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "maxItems": 32,
        "minItems": 0
      }
    },
    "required": [
      "apiVersion",
      "url",
      "token",
      "projectId",
      "externalSessionId",
      "methods",
      "profile"
    ]
  }
};

// Discovery filters narrow an existing grant; omitted owner starts at the owner index.
Object.assign(discoverySchemas.IndexInput.properties.query.properties, {
  owner: { type: 'string', minLength: 1, maxLength: 128 },
  search: { type: 'string', minLength: 1, maxLength: 128 }
});
discoverySchemas.IndexOutput.properties.groups = {
  type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false,
    properties: { owner: { type: 'string' }, operations: { type: 'integer', minimum: 1 }, name: { type: 'string', maxLength: 64 }, summary: { type: 'string', maxLength: 240 } }, required: ['owner', 'operations'] }
};
