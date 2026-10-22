// Exact expanded phase0-0.1 profiles. Inert metadata; no implementation import.
export const enhancementSchemas: Record<string, any> = {
  "PresentationReadInput": {
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
      "compositionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
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
      "taskId",
      "compositionId",
      "query"
    ]
  },
  "PresentationReadOutput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "taskVersion": {
        "type": "integer",
        "minimum": 1
      },
      "presenterGeneration": {
        "type": "integer",
        "minimum": 1
      },
      "composition": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "compositionId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "version": {
            "type": "integer",
            "minimum": 1
          }
        },
        "required": [
          "compositionId",
          "version"
        ]
      },
      "basisWitness": {
        "anyOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "witnessId": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "projectId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              "taskId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              "compositionId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              "compositionVersion": {
                "type": "integer",
                "minimum": 1
              },
              "sourceEvent": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "adapterId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "adapterEpoch": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "sourceSeq": {
                    "type": "integer",
                    "minimum": 0
                  }
                },
                "required": [
                  "adapterId",
                  "adapterEpoch",
                  "sourceSeq"
                ]
              },
              "policyRef": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "views": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "viewId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                    },
                    "component": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "componentVersion": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "resource": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "id": {
                          "type": "string",
                          "minLength": 1
                        },
                        "version": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        }
                      },
                      "required": [
                        "id",
                        "version"
                      ]
                    }
                  },
                  "required": [
                    "viewId",
                    "component",
                    "componentVersion",
                    "resource"
                  ]
                },
                "maxItems": 8,
                "minItems": 1
              },
              "dataValidation": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "integrity": {
                    "const": "hash-verified"
                  },
                  "shape": {
                    "const": "typed-table-read"
                  },
                  "domain": {
                    "const": "not-judged"
                  }
                },
                "required": [
                  "integrity",
                  "shape",
                  "domain"
                ]
              },
              "at": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "witnessId",
              "projectId",
              "taskId",
              "compositionId",
              "compositionVersion",
              "sourceEvent",
              "policyRef",
              "views",
              "dataValidation",
              "at"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "latestVisibility": {
        "anyOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "observationId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              "compositionVersion": {
                "type": "integer",
                "minimum": 1
              },
              "evidence": {
                "enum": [
                  "dom-visible",
                  "hidden",
                  "unmounted",
                  "unavailable"
                ]
              },
              "clientId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              }
            },
            "required": [
              "observationId",
              "compositionVersion",
              "evidence",
              "clientId"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "ownerSummary": {
        "anyOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "resource": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "id": {
                    "type": "string",
                    "minLength": 1
                  },
                  "version": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "id",
                  "version"
                ]
              },
              "totalRows": {
                "type": "integer",
                "minimum": 0
              },
              "entityKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "namespace": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "required": [
              "resource",
              "totalRows",
              "entityKey",
              "namespace"
            ]
          },
          {
            "type": "null"
          }
        ]
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
      "gap": {
        "type": "boolean"
      }
    },
    "required": [
      "taskVersion",
      "presenterGeneration",
      "composition",
      "basisWitness",
      "latestVisibility",
      "ownerSummary",
      "next",
      "complete",
      "gap"
    ]
  },
  "EnhanceInput": {
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
      "compositionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "presenterBindingId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "presenterGeneration": {
        "type": "integer",
        "minimum": 1
      },
      "expectedVersion": {
        "type": "integer",
        "minimum": 1
      },
      "changeId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "basisWitnessId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "basisObservationId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "enhancement": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "emphasisViewId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80
          },
          "note": {
            "type": "string",
            "minLength": 1,
            "maxLength": 600
          }
        },
        "required": [
          "emphasisViewId"
        ]
      }
    },
    "required": [
      "projectId",
      "taskId",
      "compositionId",
      "presenterBindingId",
      "presenterGeneration",
      "expectedVersion",
      "changeId",
      "basisWitnessId",
      "basisObservationId",
      "enhancement"
    ]
  },
  "AgentNoteProps": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "text": {
        "type": "string",
        "minLength": 1,
        "maxLength": 600
      },
      "authorBindingId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "basisWitnessId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "label": {
        "const": "Agent note"
      }
    },
    "required": [
      "text",
      "authorBindingId",
      "basisWitnessId",
      "label"
    ]
  }
};
