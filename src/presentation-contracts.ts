// Inert phase0-0.1 application/renderer snapshot; no optional owner import.
export const presentationSchemas: Record<string, any> = {
  "BasicPolicy": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "policyVersion": {
        "const": 1
      },
      "policyId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "sourceResource": {
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
      "candidateDeclaration": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "kind": {
                "const": "file"
              },
              "format": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "mimeType": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "required": [
                  "mimeType"
                ]
              }
            },
            "required": [
              "path",
              "kind",
              "format"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "kind": {
                "const": "table"
              },
              "format": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "encoding": {
                    "enum": [
                      "csv",
                      "json-rows"
                    ]
                  },
                  "columns": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "name": {
                          "type": "string",
                          "minLength": 1
                        },
                        "type": {
                          "enum": [
                            "string",
                            "number",
                            "boolean"
                          ]
                        },
                        "nullValues": {
                          "type": "array",
                          "items": {
                            "type": "string"
                          },
                          "maxItems": 16
                        }
                      },
                      "required": [
                        "name",
                        "type",
                        "nullValues"
                      ]
                    },
                    "minItems": 1,
                    "maxItems": 256
                  },
                  "key": {
                    "anyOf": [
                      {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "column": {
                            "type": "string",
                            "minLength": 1
                          },
                          "namespace": {
                            "type": "string",
                            "minLength": 1
                          }
                        },
                        "required": [
                          "column",
                          "namespace"
                        ]
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "encoding",
                  "columns",
                  "key"
                ]
              }
            },
            "required": [
              "path",
              "kind",
              "format"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "kind": {
                "const": "media"
              },
              "format": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "mimeType": {
                    "enum": [
                      "image/png",
                      "image/jpeg",
                      "image/svg+xml",
                      "application/pdf"
                    ]
                  },
                  "pages": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "width": {
                    "type": "number",
                    "exclusiveMinimum": 0
                  },
                  "height": {
                    "type": "number",
                    "exclusiveMinimum": 0
                  }
                },
                "required": [
                  "mimeType"
                ]
              }
            },
            "required": [
              "path",
              "kind",
              "format"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1
              },
              "kind": {
                "const": "object"
              },
              "format": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "encoding": {
                    "const": "json"
                  },
                  "observation": {
                    "const": "exported-snapshot"
                  },
                  "classes": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1
                    },
                    "maxItems": 32
                  }
                },
                "required": [
                  "encoding",
                  "observation",
                  "classes"
                ]
              }
            },
            "required": [
              "path",
              "kind",
              "format"
            ]
          }
        ]
      },
      "compositionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "sourceViewId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "candidateViewId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "tableComponent": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "const": "rho.table"
          },
          "version": {
            "const": "0.2.0"
          }
        },
        "required": [
          "id",
          "version"
        ]
      },
      "comparison": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "mapping": {
            "const": "equal-string"
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
          "mapping",
          "entityKey",
          "namespace"
        ]
      },
      "groupPresentation": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "mode": {
            "const": "split"
          },
          "axis": {
            "const": "horizontal"
          },
          "weights": {
            "type": "array",
            "items": {
              "type": "number",
              "exclusiveMinimum": 0,
              "maximum": 100
            },
            "minItems": 2,
            "maxItems": 2
          }
        },
        "required": [
          "mode",
          "axis",
          "weights"
        ]
      }
    },
    "required": [
      "policyVersion",
      "policyId",
      "sourceResource",
      "candidateDeclaration",
      "compositionId",
      "sourceViewId",
      "candidateViewId",
      "tableComponent",
      "comparison",
      "groupPresentation"
    ]
  },
  "BasicInput": {
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
      "configurationId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "policyRef": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "candidate": {
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
      "expectedVersion": {
        "type": "integer",
        "minimum": 0
      }
    },
    "required": [
      "projectId",
      "taskId",
      "sourceEvent",
      "configurationId",
      "policyRef",
      "candidate",
      "expectedVersion"
    ]
  },
  "Witness": {
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
  "CompositionCommit": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "compositionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "commitVersion": {
        "type": "integer",
        "minimum": 1
      },
      "currentVersion": {
        "type": "integer",
        "minimum": 1
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
      },
      "witness": {
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
      "witnessState": {
        "enum": [
          "retained",
          "pending",
          "expired"
        ]
      },
      "visibility": {
        "const": "not-observed-by-this-write"
      }
    },
    "required": [
      "compositionId",
      "commitVersion",
      "currentVersion",
      "receipt",
      "witness",
      "witnessState",
      "visibility"
    ]
  },
  "GroupPresentation": {
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "mode": {
            "const": "tabs"
          }
        },
        "required": [
          "mode"
        ]
      },
      {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "mode": {
            "const": "split"
          },
          "axis": {
            "enum": [
              "horizontal",
              "vertical"
            ]
          },
          "weights": {
            "type": "array",
            "items": {
              "type": "number",
              "exclusiveMinimum": 0,
              "maximum": 100
            },
            "minItems": 2,
            "maxItems": 256
          }
        },
        "required": [
          "mode",
          "axis",
          "weights"
        ]
      }
    ]
  },
  "VisibilityInput": {
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
      "compositionVersion": {
        "type": "integer",
        "minimum": 1
      },
      "witnessId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "viewId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "observationId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "clientId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "clientEpoch": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "rendererBuild": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "evidence": {
        "enum": [
          "dom-visible",
          "hidden",
          "unmounted",
          "unavailable"
        ]
      },
      "coverage": {
        "anyOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "table-dom"
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
              },
              "query": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "offset": {
                    "type": "integer",
                    "minimum": 0
                  },
                  "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 1000
                  },
                  "sort": {
                    "anyOf": [
                      {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "column": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 128
                          },
                          "direction": {
                            "enum": [
                              "asc",
                              "desc"
                            ]
                          }
                        },
                        "required": [
                          "column",
                          "direction"
                        ]
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "filter": {
                    "anyOf": [
                      {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "column": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 128
                          },
                          "op": {
                            "enum": [
                              "eq",
                              "lt",
                              "gt",
                              "isNull"
                            ]
                          },
                          "value": {
                            "type": [
                              "string",
                              "number",
                              "boolean",
                              "null"
                            ]
                          }
                        },
                        "required": [
                          "column",
                          "op"
                        ]
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "required": [
                  "offset",
                  "limit",
                  "sort",
                  "filter"
                ]
              },
              "loadedRows": {
                "type": "integer",
                "minimum": 0
              },
              "visibleRows": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "entityKey": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    },
                    "columns": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128
                      },
                      "maxItems": 256,
                      "minItems": 1
                    }
                  },
                  "required": [
                    "entityKey",
                    "columns"
                  ]
                },
                "maxItems": 1000,
                "minItems": 0
              },
              "namespace": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "rowValuesDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "documentVisible": {
                "type": "boolean"
              },
              "panelWithinViewport": {
                "type": "boolean"
              },
              "keyCellsWithinViewport": {
                "type": "boolean"
              },
              "framesAfterData": {
                "type": "integer",
                "minimum": 2,
                "maximum": 10
              },
              "occlusion": {
                "enum": [
                  "not-verified",
                  "element-hit-tested"
                ]
              }
            },
            "required": [
              "kind",
              "resource",
              "query",
              "loadedRows",
              "visibleRows",
              "namespace",
              "rowValuesDigest",
              "documentVisible",
              "panelWithinViewport",
              "keyCellsWithinViewport",
              "framesAfterData",
              "occlusion"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "time": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "browserObservedAt": {
            "type": "string",
            "format": "date-time"
          },
          "performanceNowMs": {
            "type": "number",
            "minimum": 0
          },
          "clockDomain": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          }
        },
        "required": [
          "browserObservedAt",
          "performanceNowMs",
          "clockDomain"
        ]
      }
    },
    "required": [
      "projectId",
      "taskId",
      "compositionId",
      "compositionVersion",
      "witnessId",
      "viewId",
      "observationId",
      "clientId",
      "clientEpoch",
      "rendererBuild",
      "evidence",
      "coverage",
      "time"
    ]
  },
  "VisibilityReceipt": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "observationId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "requestDigest": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "serverReceivedAt": {
        "type": "string",
        "format": "date-time"
      },
      "cursor": {
        "type": "integer",
        "minimum": 1
      },
      "historicalAtReceipt": {
        "type": "boolean"
      },
      "firstResourceObservationId": {
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
      "firstLayoutObservationId": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "observationId",
      "requestDigest",
      "serverReceivedAt",
      "cursor",
      "historicalAtReceipt",
      "firstResourceObservationId",
      "firstLayoutObservationId"
    ]
  },
  "VisibilityReadInput": {
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
      "viewId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "clientId": {
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
      "viewId",
      "clientId",
      "query"
    ]
  },
  "VisibilityReadOutput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "observations": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "request": {
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
                "compositionVersion": {
                  "type": "integer",
                  "minimum": 1
                },
                "witnessId": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "viewId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                },
                "observationId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                },
                "clientId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                },
                "clientEpoch": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                },
                "rendererBuild": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "evidence": {
                  "enum": [
                    "dom-visible",
                    "hidden",
                    "unmounted",
                    "unavailable"
                  ]
                },
                "coverage": {
                  "anyOf": [
                    {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "kind": {
                          "const": "table-dom"
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
                        },
                        "query": {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "offset": {
                              "type": "integer",
                              "minimum": 0
                            },
                            "limit": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 1000
                            },
                            "sort": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "additionalProperties": false,
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128
                                    },
                                    "direction": {
                                      "enum": [
                                        "asc",
                                        "desc"
                                      ]
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "direction"
                                  ]
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "filter": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "additionalProperties": false,
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128
                                    },
                                    "op": {
                                      "enum": [
                                        "eq",
                                        "lt",
                                        "gt",
                                        "isNull"
                                      ]
                                    },
                                    "value": {
                                      "type": [
                                        "string",
                                        "number",
                                        "boolean",
                                        "null"
                                      ]
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "op"
                                  ]
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            }
                          },
                          "required": [
                            "offset",
                            "limit",
                            "sort",
                            "filter"
                          ]
                        },
                        "loadedRows": {
                          "type": "integer",
                          "minimum": 0
                        },
                        "visibleRows": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                              "entityKey": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              },
                              "columns": {
                                "type": "array",
                                "items": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 128
                                },
                                "maxItems": 256,
                                "minItems": 1
                              }
                            },
                            "required": [
                              "entityKey",
                              "columns"
                            ]
                          },
                          "maxItems": 1000,
                          "minItems": 0
                        },
                        "namespace": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        },
                        "rowValuesDigest": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "documentVisible": {
                          "type": "boolean"
                        },
                        "panelWithinViewport": {
                          "type": "boolean"
                        },
                        "keyCellsWithinViewport": {
                          "type": "boolean"
                        },
                        "framesAfterData": {
                          "type": "integer",
                          "minimum": 2,
                          "maximum": 10
                        },
                        "occlusion": {
                          "enum": [
                            "not-verified",
                            "element-hit-tested"
                          ]
                        }
                      },
                      "required": [
                        "kind",
                        "resource",
                        "query",
                        "loadedRows",
                        "visibleRows",
                        "namespace",
                        "rowValuesDigest",
                        "documentVisible",
                        "panelWithinViewport",
                        "keyCellsWithinViewport",
                        "framesAfterData",
                        "occlusion"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "time": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "browserObservedAt": {
                      "type": "string",
                      "format": "date-time"
                    },
                    "performanceNowMs": {
                      "type": "number",
                      "minimum": 0
                    },
                    "clockDomain": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                    }
                  },
                  "required": [
                    "browserObservedAt",
                    "performanceNowMs",
                    "clockDomain"
                  ]
                }
              },
              "required": [
                "projectId",
                "taskId",
                "compositionId",
                "compositionVersion",
                "witnessId",
                "viewId",
                "observationId",
                "clientId",
                "clientEpoch",
                "rendererBuild",
                "evidence",
                "coverage",
                "time"
              ]
            },
            "receipt": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "observationId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                },
                "requestDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "serverReceivedAt": {
                  "type": "string",
                  "format": "date-time"
                },
                "cursor": {
                  "type": "integer",
                  "minimum": 1
                },
                "historicalAtReceipt": {
                  "type": "boolean"
                },
                "firstResourceObservationId": {
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
                "firstLayoutObservationId": {
                  "anyOf": [
                    {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "observationId",
                "requestDigest",
                "serverReceivedAt",
                "cursor",
                "historicalAtReceipt",
                "firstResourceObservationId",
                "firstLayoutObservationId"
              ]
            }
          },
          "required": [
            "request",
            "receipt"
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
      },
      "retainedFromCursor": {
        "type": "integer",
        "minimum": 0
      },
      "gap": {
        "type": "boolean"
      }
    },
    "required": [
      "observations",
      "next",
      "complete",
      "retainedFromCursor",
      "gap"
    ]
  }
};
