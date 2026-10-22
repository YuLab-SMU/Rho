// Frozen phase0-0.1 native-entry wire snapshot. Format hints are revalidated by their actual owners.
export function isNativeTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}
export const nativeSchemas: Record<string, any> = {
  "BindingOpenExtended": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "projectId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "externalSessionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "adapter": {
        "const": "claude-code-mcp"
      },
      "attachment": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "taskId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "role": {
            "enum": [
              "business",
              "presentation"
            ]
          },
          "adapterRegistrationId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "transportCapabilities": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "inputMode": {
                "enum": [
                  "pull-tool-result",
                  "post-tool-boundary",
                  "queued-turn",
                  "unsupported"
                ]
              },
              "inboxLookup": {
                "type": "boolean"
              },
              "inboxDeduplication": {
                "enum": [
                  "none",
                  "retained-original-delivery"
                ]
              },
              "hookEmissionDeduplication": {
                "enum": [
                  "none",
                  "no-reemit-after-attempt"
                ]
              },
              "modelConsumptionAck": {
                "const": false
              },
              "nativeExecutionDeduplication": {
                "const": false
              }
            },
            "required": [
              "inputMode",
              "inboxLookup",
              "inboxDeduplication",
              "hookEmissionDeduplication",
              "modelConsumptionAck",
              "nativeExecutionDeduplication"
            ]
          }
        },
        "required": [
          "taskId",
          "role",
          "adapterRegistrationId",
          "transportCapabilities"
        ]
      }
    },
    "required": [
      "projectId",
      "externalSessionId",
      "adapter"
    ]
  },
  "BindingRecordExtension": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "id": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "projectId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "principal": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "externalSessionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "adapter": {
        "const": "claude-code-mcp"
      },
      "status": {
        "enum": [
          "connected",
          "disconnected"
        ]
      },
      "at": {
        "type": "string",
        "format": "date-time"
      },
      "attachment": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "taskId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "role": {
            "enum": [
              "business",
              "presentation"
            ]
          },
          "adapterRegistrationId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "transportCapabilities": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "inputMode": {
                "enum": [
                  "pull-tool-result",
                  "post-tool-boundary",
                  "queued-turn",
                  "unsupported"
                ]
              },
              "inboxLookup": {
                "type": "boolean"
              },
              "inboxDeduplication": {
                "enum": [
                  "none",
                  "retained-original-delivery"
                ]
              },
              "hookEmissionDeduplication": {
                "enum": [
                  "none",
                  "no-reemit-after-attempt"
                ]
              },
              "modelConsumptionAck": {
                "const": false
              },
              "nativeExecutionDeduplication": {
                "const": false
              }
            },
            "required": [
              "inputMode",
              "inboxLookup",
              "inboxDeduplication",
              "hookEmissionDeduplication",
              "modelConsumptionAck",
              "nativeExecutionDeduplication"
            ]
          }
        },
        "required": [
          "taskId",
          "role",
          "adapterRegistrationId",
          "transportCapabilities"
        ]
      }
    },
    "required": [
      "id",
      "projectId",
      "principal",
      "externalSessionId",
      "adapter",
      "status",
      "at",
      "attachment"
    ]
  },
  "RouteInput": {
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
  "RouteOutput": {
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
  },
  "ActivityAppendInput": {
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
      "bindingId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "adapterId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "adapterEpoch": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "events": {
        "type": "array",
        "items": {
          "oneOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "sourceSeq": {
                  "type": "integer",
                  "minimum": 0
                },
                "kind": {
                  "enum": [
                    "tool.requested",
                    "tool.returned",
                    "tool.rejected",
                    "tool.observation-lost"
                  ]
                },
                "nativeToolUseId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                },
                "tool": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 80
                },
                "at": {
                  "type": "string",
                  "format": "date-time"
                },
                "detailsRef": {
                  "anyOf": [
                    {
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
                    {
                      "type": "null"
                    }
                  ]
                },
                "fetchId": {
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
                "outcome": {
                  "enum": [
                    "requested",
                    "returned",
                    "rejected",
                    "partial",
                    "unknown"
                  ]
                }
              },
              "required": [
                "sourceSeq",
                "kind",
                "nativeToolUseId",
                "tool",
                "at",
                "detailsRef",
                "outcome"
              ]
            },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "sourceSeq": {
                  "type": "integer",
                  "minimum": 0
                },
                "kind": {
                  "const": "artifact.ready"
                },
                "nativeToolUseId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                },
                "at": {
                  "type": "string",
                  "format": "date-time"
                },
                "output": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "declaration": {
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
                    "expectedDigest": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "role": {
                      "enum": [
                        "candidate",
                        "result"
                      ]
                    },
                    "policyRef": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "declaration",
                    "expectedDigest",
                    "role",
                    "policyRef"
                  ]
                }
              },
              "required": [
                "sourceSeq",
                "kind",
                "nativeToolUseId",
                "at",
                "output"
              ]
            }
          ]
        },
        "maxItems": 64,
        "minItems": 1
      }
    },
    "required": [
      "projectId",
      "taskId",
      "bindingId",
      "adapterId",
      "adapterEpoch",
      "events"
    ]
  },
  "ActivityAppendOutput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "accepted": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "sourceSeq": {
              "type": "integer",
              "minimum": 0
            },
            "cursor": {
              "type": "integer",
              "minimum": 0
            },
            "eventId": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "sourceSeq",
            "cursor",
            "eventId"
          ]
        },
        "maxItems": 64,
        "minItems": 1
      },
      "serverObservedAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "accepted",
      "serverObservedAt"
    ]
  },
  "NativeActivityReadInput": {
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
      "source": {
        "const": "native"
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
      "source",
      "query"
    ]
  },
  "NativeActivityReadOutput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "cursor": {
        "type": "integer",
        "minimum": 0
      },
      "retainedFrom": {
        "type": "integer",
        "minimum": 0
      },
      "entries": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "cursor": {
              "type": "integer",
              "minimum": 1
            },
            "eventId": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "bindingId": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "adapterId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
            },
            "adapterEpoch": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
            },
            "event": {
              "oneOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "sourceSeq": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "kind": {
                      "enum": [
                        "tool.requested",
                        "tool.returned",
                        "tool.rejected",
                        "tool.observation-lost"
                      ]
                    },
                    "nativeToolUseId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                    },
                    "tool": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 80
                    },
                    "at": {
                      "type": "string",
                      "format": "date-time"
                    },
                    "detailsRef": {
                      "anyOf": [
                        {
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
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "fetchId": {
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
                    "outcome": {
                      "enum": [
                        "requested",
                        "returned",
                        "rejected",
                        "partial",
                        "unknown"
                      ]
                    }
                  },
                  "required": [
                    "sourceSeq",
                    "kind",
                    "nativeToolUseId",
                    "tool",
                    "at",
                    "detailsRef",
                    "outcome"
                  ]
                },
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "sourceSeq": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "kind": {
                      "const": "artifact.ready"
                    },
                    "nativeToolUseId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                    },
                    "at": {
                      "type": "string",
                      "format": "date-time"
                    },
                    "output": {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "declaration": {
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
                        "expectedDigest": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "role": {
                          "enum": [
                            "candidate",
                            "result"
                          ]
                        },
                        "policyRef": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        }
                      },
                      "required": [
                        "declaration",
                        "expectedDigest",
                        "role",
                        "policyRef"
                      ]
                    }
                  },
                  "required": [
                    "sourceSeq",
                    "kind",
                    "nativeToolUseId",
                    "at",
                    "output"
                  ]
                }
              ]
            }
          },
          "required": [
            "cursor",
            "eventId",
            "bindingId",
            "adapterId",
            "adapterEpoch",
            "event"
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
      "gap": {
        "type": "boolean"
      }
    },
    "required": [
      "cursor",
      "retainedFrom",
      "entries",
      "next",
      "complete",
      "gap"
    ]
  }
};
