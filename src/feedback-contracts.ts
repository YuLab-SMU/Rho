// Inert phase0-0.1 feedback wire snapshot; source semantics stay with owners.
export const feedbackSchemas: Record<string, any> = {
  "FeedbackSubmitInput": {
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
      "submissionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "draft": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "documentId": {
            "type": "string",
            "minLength": 1
          },
          "version": {
            "type": "integer",
            "minimum": 1
          }
        },
        "required": [
          "documentId",
          "version"
        ]
      },
      "anchor": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "document"
              },
              "documentId": {
                "type": "string",
                "minLength": 1
              },
              "version": {
                "type": "integer",
                "minimum": 1
              },
              "from": {
                "type": "integer",
                "minimum": 0
              },
              "to": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "kind",
              "documentId",
              "version",
              "from",
              "to"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "table"
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
              "entities": {
                "type": "array",
                "minItems": 1,
                "maxItems": 1024,
                "uniqueItems": true,
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              }
            },
            "required": [
              "kind",
              "resource",
              "entities"
            ]
          }
        ]
      },
      "relatedDocumentId": {
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
      "routeExpectation": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "taskVersion": {
            "type": "integer",
            "minimum": 1
          },
          "targetBindingId": {
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
          "taskVersion",
          "targetBindingId"
        ]
      }
    },
    "required": [
      "projectId",
      "taskId",
      "compositionId",
      "submissionId",
      "draft",
      "anchor",
      "relatedDocumentId",
      "routeExpectation"
    ]
  },
  "SubmissionRecord": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "submissionId": {
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
      "stages": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "annotation": {
            "enum": [
              "pending",
              "committed",
              "needs-reconcile"
            ]
          },
          "context": {
            "enum": [
              "pending",
              "prepared",
              "needs-reconcile"
            ]
          },
          "queue": {
            "enum": [
              "pending",
              "queued",
              "blocked",
              "needs-routing"
            ]
          }
        },
        "required": [
          "annotation",
          "context",
          "queue"
        ]
      },
      "annotation": {
        "anyOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "annotationId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              "submittedVersion": {
                "type": "integer",
                "minimum": 1
              },
              "messageId": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              }
            },
            "required": [
              "annotationId",
              "submittedVersion",
              "messageId"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "contextId": {
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
      "delivery": {
        "anyOf": [
          {
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
              "deliveryId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              "requestDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "targetBindingId": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "externalSessionId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              "adapterRegistrationId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              "contextId": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "message": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "annotationId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "submittedVersion": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "messageId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "annotationId",
                  "submittedVersion",
                  "messageId"
                ]
              },
              "taskVersion": {
                "type": "integer",
                "minimum": 1
              },
              "mode": {
                "enum": [
                  "post-tool-boundary",
                  "queued-turn"
                ]
              }
            },
            "required": [
              "projectId",
              "taskId",
              "deliveryId",
              "requestDigest",
              "targetBindingId",
              "externalSessionId",
              "adapterRegistrationId",
              "contextId",
              "message",
              "taskVersion",
              "mode"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "reason": {
        "anyOf": [
          {
            "enum": [
              "queue-full",
              "source-unavailable",
              "route-conflict",
              "owner-unavailable",
              "needs-routing",
              "context-limit"
            ]
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "submissionId",
      "requestDigest",
      "author",
      "stages",
      "annotation",
      "contextId",
      "delivery",
      "reason"
    ]
  },
  "FeedbackReadInput": {
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
      "deliveryId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "contextId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "fetchId": {
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
      "deliveryId",
      "contextId",
      "fetchId",
      "query"
    ]
  },
  "FeedbackReadOutput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "fetchReceipt": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "receiptId": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "fetchId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "deliveryId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "contextId": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "bindingId": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "principal": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "observation": {
            "enum": [
              "owner-served",
              "client-tool-returned"
            ]
          },
          "nativeToolUseId": {
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
          "at": {
            "type": "string",
            "format": "date-time"
          }
        },
        "required": [
          "receiptId",
          "fetchId",
          "deliveryId",
          "contextId",
          "bindingId",
          "principal",
          "observation",
          "nativeToolUseId",
          "at"
        ]
      },
      "contextVersion": {
        "const": 1
      },
      "feedback": {
        "anyOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "annotation": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "annotationId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "submittedVersion": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "messageId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "annotationId",
                  "submittedVersion",
                  "messageId"
                ]
              },
              "anchor": {
                "oneOf": [
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "kind": {
                        "const": "document"
                      },
                      "documentId": {
                        "type": "string",
                        "minLength": 1
                      },
                      "version": {
                        "type": "integer",
                        "minimum": 1
                      },
                      "from": {
                        "type": "integer",
                        "minimum": 0
                      },
                      "to": {
                        "type": "integer",
                        "minimum": 0
                      }
                    },
                    "required": [
                      "kind",
                      "documentId",
                      "version",
                      "from",
                      "to"
                    ]
                  },
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "kind": {
                        "const": "table"
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
                      "entities": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 1024,
                        "uniqueItems": true,
                        "items": {
                          "type": "string",
                          "minLength": 1
                        }
                      }
                    },
                    "required": [
                      "kind",
                      "resource",
                      "entities"
                    ]
                  }
                ]
              },
              "source": {
                "oneOf": [
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "kind": {
                        "const": "table"
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
                      "namespace": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128
                      },
                      "entityKey": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 128
                      },
                      "rows": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "additionalProperties": {
                            "type": [
                              "string",
                              "number",
                              "boolean",
                              "null"
                            ]
                          }
                        },
                        "maxItems": 1024,
                        "minItems": 1
                      }
                    },
                    "required": [
                      "kind",
                      "resource",
                      "namespace",
                      "entityKey",
                      "rows"
                    ]
                  },
                  {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "kind": {
                        "const": "document"
                      },
                      "source": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "kind": {
                            "const": "buffer"
                          },
                          "documentId": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "version": {
                            "type": "integer",
                            "minimum": 1
                          },
                          "path": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 4096
                          },
                          "dirty": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "kind",
                          "documentId",
                          "version",
                          "path",
                          "dirty"
                        ]
                      },
                      "sha256": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      },
                      "from": {
                        "type": "integer",
                        "minimum": 0
                      },
                      "to": {
                        "type": "integer",
                        "minimum": 0
                      },
                      "text": {
                        "type": "string",
                        "maxLength": 1048576
                      }
                    },
                    "required": [
                      "kind",
                      "source",
                      "sha256",
                      "from",
                      "to",
                      "text"
                    ]
                  }
                ]
              },
              "messageText": {
                "type": "string",
                "maxLength": 1048576
              },
              "messageDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "author": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              }
            },
            "required": [
              "annotation",
              "anchor",
              "source",
              "messageText",
              "messageDigest",
              "author"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "relatedDocumentId": {
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
      "fetchReceipt",
      "contextVersion",
      "feedback",
      "relatedDocumentId",
      "next",
      "complete"
    ]
  },
  "DeliveryStatusInput": {
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
      "submissionId": {
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
      "submissionId",
      "query"
    ]
  },
  "DeliveryStatusOutput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "snapshot": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "deliveryStoreVersion": {
            "type": "integer",
            "minimum": 0
          },
          "annotationVersion": {
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
          "deliveryStoreVersion",
          "annotationVersion"
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
      "submission": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "submissionId": {
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
          "stages": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "annotation": {
                "enum": [
                  "pending",
                  "committed",
                  "needs-reconcile"
                ]
              },
              "context": {
                "enum": [
                  "pending",
                  "prepared",
                  "needs-reconcile"
                ]
              },
              "queue": {
                "enum": [
                  "pending",
                  "queued",
                  "blocked",
                  "needs-routing"
                ]
              }
            },
            "required": [
              "annotation",
              "context",
              "queue"
            ]
          },
          "annotation": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "annotationId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "submittedVersion": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "messageId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "annotationId",
                  "submittedVersion",
                  "messageId"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "contextId": {
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
          "delivery": {
            "anyOf": [
              {
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
                  "deliveryId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "requestDigest": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "targetBindingId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "externalSessionId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "adapterRegistrationId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "contextId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "message": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "annotationId": {
                        "type": "string",
                        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                      },
                      "submittedVersion": {
                        "type": "integer",
                        "minimum": 1
                      },
                      "messageId": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      }
                    },
                    "required": [
                      "annotationId",
                      "submittedVersion",
                      "messageId"
                    ]
                  },
                  "taskVersion": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "mode": {
                    "enum": [
                      "post-tool-boundary",
                      "queued-turn"
                    ]
                  }
                },
                "required": [
                  "projectId",
                  "taskId",
                  "deliveryId",
                  "requestDigest",
                  "targetBindingId",
                  "externalSessionId",
                  "adapterRegistrationId",
                  "contextId",
                  "message",
                  "taskVersion",
                  "mode"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "reason": {
            "anyOf": [
              {
                "enum": [
                  "queue-full",
                  "source-unavailable",
                  "route-conflict",
                  "owner-unavailable",
                  "needs-routing",
                  "context-limit"
                ]
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "submissionId",
          "requestDigest",
          "author",
          "stages",
          "annotation",
          "contextId",
          "delivery",
          "reason"
        ]
      },
      "queue": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "attempts": {
            "type": "integer",
            "minimum": 0
          },
          "transport": {
            "enum": [
              "not-attempted",
              "queued",
              "attempt-recorded",
              "accepted",
              "unknown",
              "blocked"
            ]
          },
          "enqueueAck": {
            "enum": [
              "not-observed",
              "observed"
            ]
          },
          "inboxReceipt": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "deliveryId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "requestDigest": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "acceptedAt": {
                    "type": "string",
                    "format": "date-time"
                  },
                  "inboxReceiptId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "emission": {
                    "enum": [
                      "not-attempted",
                      "attempt-recorded",
                      "emitted",
                      "unknown"
                    ]
                  }
                },
                "required": [
                  "deliveryId",
                  "requestDigest",
                  "acceptedAt",
                  "inboxReceiptId",
                  "emission"
                ]
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "attempts",
          "transport",
          "enqueueAck",
          "inboxReceipt"
        ]
      },
      "fetches": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "receiptId": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "fetchId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
            },
            "deliveryId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
            },
            "contextId": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "bindingId": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "principal": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
            },
            "observation": {
              "enum": [
                "owner-served",
                "client-tool-returned"
              ]
            },
            "nativeToolUseId": {
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
            "at": {
              "type": "string",
              "format": "date-time"
            }
          },
          "required": [
            "receiptId",
            "fetchId",
            "deliveryId",
            "contextId",
            "bindingId",
            "principal",
            "observation",
            "nativeToolUseId",
            "at"
          ]
        },
        "maxItems": 128,
        "minItems": 0
      },
      "responses": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "annotationId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
            },
            "messageId": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "replyTo": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "author": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
            },
            "fromAssignedBusiness": {
              "type": "boolean"
            }
          },
          "required": [
            "annotationId",
            "messageId",
            "replyTo",
            "author",
            "fromAssignedBusiness"
          ]
        },
        "maxItems": 128,
        "minItems": 0
      },
      "retention": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "receipts": {
            "enum": [
              "retained",
              "expired",
              "unavailable"
            ]
          },
          "originalTargetPreserved": {
            "const": true
          }
        },
        "required": [
          "receipts",
          "originalTargetPreserved"
        ]
      }
    },
    "required": [
      "snapshot",
      "next",
      "complete",
      "submission",
      "queue",
      "fetches",
      "responses",
      "retention"
    ]
  },
  "DeliveryEnvelope": {
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
      "deliveryId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "requestDigest": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "targetBindingId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "externalSessionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "adapterRegistrationId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "contextId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "message": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "annotationId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "submittedVersion": {
            "type": "integer",
            "minimum": 1
          },
          "messageId": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          }
        },
        "required": [
          "annotationId",
          "submittedVersion",
          "messageId"
        ]
      },
      "taskVersion": {
        "type": "integer",
        "minimum": 1
      },
      "mode": {
        "enum": [
          "post-tool-boundary",
          "queued-turn"
        ]
      }
    },
    "required": [
      "projectId",
      "taskId",
      "deliveryId",
      "requestDigest",
      "targetBindingId",
      "externalSessionId",
      "adapterRegistrationId",
      "contextId",
      "message",
      "taskVersion",
      "mode"
    ]
  },
  "InboxReceipt": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "deliveryId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "requestDigest": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "acceptedAt": {
        "type": "string",
        "format": "date-time"
      },
      "inboxReceiptId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "emission": {
        "enum": [
          "not-attempted",
          "attempt-recorded",
          "emitted",
          "unknown"
        ]
      }
    },
    "required": [
      "deliveryId",
      "requestDigest",
      "acceptedAt",
      "inboxReceiptId",
      "emission"
    ]
  },
  "InboxLookupInput": {
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
      "deliveryId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "requestDigest": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "targetBindingId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "externalSessionId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      }
    },
    "required": [
      "projectId",
      "taskId",
      "deliveryId",
      "requestDigest",
      "targetBindingId",
      "externalSessionId"
    ]
  },
  "InboxLookupOutput": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "deliveryId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "state": {
        "enum": [
          "retained",
          "not-found",
          "expired",
          "unknown"
        ]
      },
      "receipt": {
        "anyOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "deliveryId": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
              },
              "requestDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "acceptedAt": {
                "type": "string",
                "format": "date-time"
              },
              "inboxReceiptId": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "emission": {
                "enum": [
                  "not-attempted",
                  "attempt-recorded",
                  "emitted",
                  "unknown"
                ]
              }
            },
            "required": [
              "deliveryId",
              "requestDigest",
              "acceptedAt",
              "inboxReceiptId",
              "emission"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "absenceAuthorizesReplay": {
        "const": false
      }
    },
    "required": [
      "deliveryId",
      "state",
      "receipt",
      "absenceAuthorizesReplay"
    ]
  },
  "FrozenFeedback": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "annotation": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "annotationId": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          },
          "submittedVersion": {
            "type": "integer",
            "minimum": 1
          },
          "messageId": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          }
        },
        "required": [
          "annotationId",
          "submittedVersion",
          "messageId"
        ]
      },
      "anchor": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "document"
              },
              "documentId": {
                "type": "string",
                "minLength": 1
              },
              "version": {
                "type": "integer",
                "minimum": 1
              },
              "from": {
                "type": "integer",
                "minimum": 0
              },
              "to": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "kind",
              "documentId",
              "version",
              "from",
              "to"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "table"
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
              "entities": {
                "type": "array",
                "minItems": 1,
                "maxItems": 1024,
                "uniqueItems": true,
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              }
            },
            "required": [
              "kind",
              "resource",
              "entities"
            ]
          }
        ]
      },
      "source": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "table"
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
              "namespace": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "entityKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "rows": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": {
                    "type": [
                      "string",
                      "number",
                      "boolean",
                      "null"
                    ]
                  }
                },
                "maxItems": 1024,
                "minItems": 1
              }
            },
            "required": [
              "kind",
              "resource",
              "namespace",
              "entityKey",
              "rows"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "document"
              },
              "source": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "buffer"
                  },
                  "documentId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "version": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 4096
                  },
                  "dirty": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "kind",
                  "documentId",
                  "version",
                  "path",
                  "dirty"
                ]
              },
              "sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "from": {
                "type": "integer",
                "minimum": 0
              },
              "to": {
                "type": "integer",
                "minimum": 0
              },
              "text": {
                "type": "string",
                "maxLength": 1048576
              }
            },
            "required": [
              "kind",
              "source",
              "sha256",
              "from",
              "to",
              "text"
            ]
          }
        ]
      },
      "messageText": {
        "type": "string",
        "maxLength": 1048576
      },
      "messageDigest": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "author": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      }
    },
    "required": [
      "annotation",
      "anchor",
      "source",
      "messageText",
      "messageDigest",
      "author"
    ]
  },
  "FrozenSource": {
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": {
            "const": "table"
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
          "namespace": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "entityKey": {
            "type": "string",
            "minLength": 1,
            "maxLength": 128
          },
          "rows": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": {
                "type": [
                  "string",
                  "number",
                  "boolean",
                  "null"
                ]
              }
            },
            "maxItems": 1024,
            "minItems": 1
          }
        },
        "required": [
          "kind",
          "resource",
          "namespace",
          "entityKey",
          "rows"
        ]
      },
      {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": {
            "const": "document"
          },
          "source": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "buffer"
              },
              "documentId": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "version": {
                "type": "integer",
                "minimum": 1
              },
              "path": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "dirty": {
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "documentId",
              "version",
              "path",
              "dirty"
            ]
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "from": {
            "type": "integer",
            "minimum": 0
          },
          "to": {
            "type": "integer",
            "minimum": 0
          },
          "text": {
            "type": "string",
            "maxLength": 1048576
          }
        },
        "required": [
          "kind",
          "source",
          "sha256",
          "from",
          "to",
          "text"
        ]
      }
    ]
  },
  "AnnotationRef": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "annotationId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "submittedVersion": {
        "type": "integer",
        "minimum": 1
      },
      "messageId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    "required": [
      "annotationId",
      "submittedVersion",
      "messageId"
    ]
  },
  "FetchReceipt": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "receiptId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "fetchId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "deliveryId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "contextId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "bindingId": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "principal": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "observation": {
        "enum": [
          "owner-served",
          "client-tool-returned"
        ]
      },
      "nativeToolUseId": {
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
      "at": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "receiptId",
      "fetchId",
      "deliveryId",
      "contextId",
      "bindingId",
      "principal",
      "observation",
      "nativeToolUseId",
      "at"
    ]
  },
  "DeliveryStore": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "format": {
        "const": "rho.agent-delivery/1"
      },
      "version": {
        "type": "integer",
        "minimum": 0
      },
      "records": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "submission": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "submissionId": {
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
                "stages": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "annotation": {
                      "enum": [
                        "pending",
                        "committed",
                        "needs-reconcile"
                      ]
                    },
                    "context": {
                      "enum": [
                        "pending",
                        "prepared",
                        "needs-reconcile"
                      ]
                    },
                    "queue": {
                      "enum": [
                        "pending",
                        "queued",
                        "blocked",
                        "needs-routing"
                      ]
                    }
                  },
                  "required": [
                    "annotation",
                    "context",
                    "queue"
                  ]
                },
                "annotation": {
                  "anyOf": [
                    {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "annotationId": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                        },
                        "submittedVersion": {
                          "type": "integer",
                          "minimum": 1
                        },
                        "messageId": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        }
                      },
                      "required": [
                        "annotationId",
                        "submittedVersion",
                        "messageId"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "contextId": {
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
                "delivery": {
                  "anyOf": [
                    {
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
                        "deliveryId": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                        },
                        "requestDigest": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "targetBindingId": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "externalSessionId": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                        },
                        "adapterRegistrationId": {
                          "type": "string",
                          "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                        },
                        "contextId": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "message": {
                          "type": "object",
                          "additionalProperties": false,
                          "properties": {
                            "annotationId": {
                              "type": "string",
                              "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                            },
                            "submittedVersion": {
                              "type": "integer",
                              "minimum": 1
                            },
                            "messageId": {
                              "type": "string",
                              "pattern": "^[a-f0-9]{64}$"
                            }
                          },
                          "required": [
                            "annotationId",
                            "submittedVersion",
                            "messageId"
                          ]
                        },
                        "taskVersion": {
                          "type": "integer",
                          "minimum": 1
                        },
                        "mode": {
                          "enum": [
                            "post-tool-boundary",
                            "queued-turn"
                          ]
                        }
                      },
                      "required": [
                        "projectId",
                        "taskId",
                        "deliveryId",
                        "requestDigest",
                        "targetBindingId",
                        "externalSessionId",
                        "adapterRegistrationId",
                        "contextId",
                        "message",
                        "taskVersion",
                        "mode"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "reason": {
                  "anyOf": [
                    {
                      "enum": [
                        "queue-full",
                        "source-unavailable",
                        "route-conflict",
                        "owner-unavailable",
                        "needs-routing",
                        "context-limit"
                      ]
                    },
                    {
                      "type": "null"
                    }
                  ]
                }
              },
              "required": [
                "submissionId",
                "requestDigest",
                "author",
                "stages",
                "annotation",
                "contextId",
                "delivery",
                "reason"
              ]
            },
            "originalInput": {
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
                "submissionId": {
                  "type": "string",
                  "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                },
                "draft": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "documentId": {
                      "type": "string",
                      "minLength": 1
                    },
                    "version": {
                      "type": "integer",
                      "minimum": 1
                    }
                  },
                  "required": [
                    "documentId",
                    "version"
                  ]
                },
                "anchor": {
                  "oneOf": [
                    {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "kind": {
                          "const": "document"
                        },
                        "documentId": {
                          "type": "string",
                          "minLength": 1
                        },
                        "version": {
                          "type": "integer",
                          "minimum": 1
                        },
                        "from": {
                          "type": "integer",
                          "minimum": 0
                        },
                        "to": {
                          "type": "integer",
                          "minimum": 0
                        }
                      },
                      "required": [
                        "kind",
                        "documentId",
                        "version",
                        "from",
                        "to"
                      ]
                    },
                    {
                      "type": "object",
                      "additionalProperties": false,
                      "properties": {
                        "kind": {
                          "const": "table"
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
                        "entities": {
                          "type": "array",
                          "minItems": 1,
                          "maxItems": 1024,
                          "uniqueItems": true,
                          "items": {
                            "type": "string",
                            "minLength": 1
                          }
                        }
                      },
                      "required": [
                        "kind",
                        "resource",
                        "entities"
                      ]
                    }
                  ]
                },
                "relatedDocumentId": {
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
                "routeExpectation": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "taskVersion": {
                      "type": "integer",
                      "minimum": 1
                    },
                    "targetBindingId": {
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
                    "taskVersion",
                    "targetBindingId"
                  ]
                }
              },
              "required": [
                "projectId",
                "taskId",
                "compositionId",
                "submissionId",
                "draft",
                "anchor",
                "relatedDocumentId",
                "routeExpectation"
              ]
            },
            "pinnedRoute": {
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
            "attempts": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "number": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "at": {
                    "type": "string",
                    "format": "date-time"
                  },
                  "targetBindingId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "externalSessionId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  }
                },
                "required": [
                  "number",
                  "at",
                  "targetBindingId",
                  "externalSessionId"
                ]
              },
              "maxItems": 128,
              "minItems": 0
            },
            "inboxReceipt": {
              "anyOf": [
                {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "deliveryId": {
                      "type": "string",
                      "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                    },
                    "requestDigest": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "acceptedAt": {
                      "type": "string",
                      "format": "date-time"
                    },
                    "inboxReceiptId": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "emission": {
                      "enum": [
                        "not-attempted",
                        "attempt-recorded",
                        "emitted",
                        "unknown"
                      ]
                    }
                  },
                  "required": [
                    "deliveryId",
                    "requestDigest",
                    "acceptedAt",
                    "inboxReceiptId",
                    "emission"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "fetchReceipts": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "receiptId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "fetchId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "deliveryId": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "contextId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "bindingId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "principal": {
                    "type": "string",
                    "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
                  },
                  "observation": {
                    "enum": [
                      "owner-served",
                      "client-tool-returned"
                    ]
                  },
                  "nativeToolUseId": {
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
                  "at": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": [
                  "receiptId",
                  "fetchId",
                  "deliveryId",
                  "contextId",
                  "bindingId",
                  "principal",
                  "observation",
                  "nativeToolUseId",
                  "at"
                ]
              },
              "maxItems": 128,
              "minItems": 0
            }
          },
          "required": [
            "submission",
            "originalInput",
            "pinnedRoute",
            "attempts",
            "inboxReceipt",
            "fetchReceipts"
          ]
        },
        "maxItems": 128,
        "minItems": 0
      },
      "receiptRetentionFrom": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "format",
      "version",
      "records",
      "receiptRetentionFrom"
    ]
  },
  "FeedbackComposerProps": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "taskId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "sourceSelectionScope": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": {
            "const": "shared"
          },
          "id": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
          }
        },
        "required": [
          "kind",
          "id"
        ]
      }
    },
    "required": [
      "title",
      "taskId",
      "sourceSelectionScope"
    ]
  },
  "AnnotationMessage": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "id": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "author": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "at": {
        "type": "string",
        "format": "date-time"
      },
      "draft": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "source": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "buffer"
              },
              "documentId": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "version": {
                "type": "integer",
                "minimum": 1
              },
              "path": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4096
              },
              "dirty": {
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "documentId",
              "version",
              "path",
              "dirty"
            ]
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "text": {
            "type": "string",
            "maxLength": 1048576
          }
        },
        "required": [
          "source",
          "sha256",
          "text"
        ]
      },
      "replyTo": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    "required": [
      "id",
      "author",
      "at",
      "draft"
    ]
  },
  "AnnotationThreadProfile": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "annotationId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:@-]{1,128}$"
      },
      "version": {
        "type": "integer",
        "minimum": 1
      },
      "anchor": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "document"
              },
              "documentId": {
                "type": "string",
                "minLength": 1
              },
              "version": {
                "type": "integer",
                "minimum": 1
              },
              "from": {
                "type": "integer",
                "minimum": 0
              },
              "to": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "kind",
              "documentId",
              "version",
              "from",
              "to"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "table"
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
              "entities": {
                "type": "array",
                "minItems": 1,
                "maxItems": 1024,
                "uniqueItems": true,
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              }
            },
            "required": [
              "kind",
              "resource",
              "entities"
            ]
          }
        ]
      },
      "source": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "table"
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
              "namespace": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "entityKey": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "rows": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": {
                    "type": [
                      "string",
                      "number",
                      "boolean",
                      "null"
                    ]
                  }
                },
                "maxItems": 1024,
                "minItems": 1
              }
            },
            "required": [
              "kind",
              "resource",
              "namespace",
              "entityKey",
              "rows"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "kind": {
                "const": "document"
              },
              "source": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "const": "buffer"
                  },
                  "documentId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "version": {
                    "type": "integer",
                    "minimum": 1
                  },
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 4096
                  },
                  "dirty": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "kind",
                  "documentId",
                  "version",
                  "path",
                  "dirty"
                ]
              },
              "sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "from": {
                "type": "integer",
                "minimum": 0
              },
              "to": {
                "type": "integer",
                "minimum": 0
              },
              "text": {
                "type": "string",
                "maxLength": 1048576
              }
            },
            "required": [
              "kind",
              "source",
              "sha256",
              "from",
              "to",
              "text"
            ]
          }
        ]
      },
      "messages": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "author": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "at": {
              "type": "string",
              "format": "date-time"
            },
            "draft": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "source": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "kind": {
                      "const": "buffer"
                    },
                    "documentId": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    },
                    "version": {
                      "type": "integer",
                      "minimum": 1
                    },
                    "path": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 4096
                    },
                    "dirty": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "kind",
                    "documentId",
                    "version",
                    "path",
                    "dirty"
                  ]
                },
                "sha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "text": {
                  "type": "string",
                  "maxLength": 1048576
                }
              },
              "required": [
                "source",
                "sha256",
                "text"
              ]
            },
            "replyTo": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "id",
            "author",
            "at",
            "draft"
          ]
        },
        "maxItems": 256,
        "minItems": 1
      },
      "receipts": {
        "type": "array",
        "items": {
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
        "maxItems": 256,
        "minItems": 1
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
      "retainedFromVersion": {
        "type": "integer",
        "minimum": 1
      },
      "sourceStatus": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "state": {
                "enum": [
                  "same-version",
                  "version-differs"
                ]
              },
              "currentVersion": {
                "type": "integer",
                "minimum": 1
              },
              "anchoredVersion": {
                "type": "integer",
                "minimum": 1
              }
            },
            "required": [
              "state",
              "currentVersion",
              "anchoredVersion"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "state": {
                "const": "same-version"
              }
            },
            "required": [
              "state"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "state": {
                "const": "snapshot-retained"
              }
            },
            "required": [
              "state"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "state": {
                "const": "source-unavailable"
              },
              "snapshot": {
                "const": "retained"
              }
            },
            "required": [
              "state",
              "snapshot"
            ]
          }
        ]
      }
    },
    "required": [
      "annotationId",
      "version",
      "anchor",
      "source",
      "messages",
      "receipts",
      "retainedFromVersion"
    ]
  }
};
