# Hub API Endpoints

We have open endpoints that you can use to retrieve information from the Hub as well as perform certain actions such as creating model, dataset or Space repos. We offer a wrapper Python client, [`huggingface_hub`](https://github.com/huggingface/huggingface_hub), and a JS client, [`huggingface.js`](https://github.com/huggingface/huggingface.js), that allow easy access to these endpoints. We also provide [webhooks](https://huggingface.co/docs/hub/webhooks) to receive real-time incremental info about repos. Enjoy!

The base URL for those endpoints below is `https://huggingface.co`. For example, to construct the `/api/models` call below, one can call the URL [https://huggingface.co/api/models](https://huggingface.co/api/models).

If you're an Agent, you might prefer the [markdown version OpenAPI spec](https://huggingface.co/.well-known/openapi.md).


**Base URL:** `https://huggingface.co`

## Auth

The following endpoints get information about your currently used user based on the passed token.

### GET /api/whoami-v2

**Get user info**

Get information about the user and auth method used

**Responses:**

- **200**: Auth information

## Models

Get information from all models on the Hub.

### GET /api/models/{namespace}/{repo}/treesize/{rev}/{path}

**Get folder size**

Get the total size of a repository at a given revision, optionally under a specific subpath. Returns the total size in bytes of all files under the specified path (recursively). If a file is stored via Xet/LFS, the LFS file size is used.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |

**Responses:**

- **200**: Total size of a repository at a given revision, under the given path

### GET /api/models/{namespace}/{repo}/lfs-files

**List Large files**

List Xet/LFS files for a repo

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| cursor | query | string | No |  |
| limit | query | integer | No |  |
| xet | query | string | No |  |

**Responses:**

- **200**: List of Xet/LFS files for the repo

### POST /api/models/{namespace}/{repo}/lfs-files/batch

**Delete Large files**

Delete Xet/LFS files in batch

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "deletions": {
      "type": "object",
      "properties": {
        "sha": {
          "minItems": 1,
          "maxItems": 1000,
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "rewriteHistory": {
          "default": true,
          "type": "boolean"
        }
      },
      "required": [
        "sha"
      ]
    }
  },
  "required": [
    "deletions"
  ]
}
```

### DELETE /api/models/{namespace}/{repo}/lfs-files/{sha}

**Delete Large file**

Delete a Xet/LFS file

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| sha | path | string | Yes |  |
| rewriteHistory | query | string | No |  |

### POST /api/models/{namespace}/{repo}/lfs-files/duplicate

**Duplicate xet files**

Duplicate xet-stored files from this repo (source) into another repo (target) by xet hash, without re-uploading file bytes. The caller must then commit the files with their sha256/size as usual.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "type": {
          "enum": [
            "dataset",
            "model",
            "space",
            "kernel"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "type",
        "name"
      ]
    },
    "files": {
      "minItems": 1,
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "xetHash": {
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-fA-F]{64}$"
          },
          "sha256": {
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-fA-F]{64}$"
          },
          "filename": {
            "type": "string",
            "maxLength": 1000
          }
        },
        "required": [
          "xetHash",
          "sha256"
        ]
      }
    }
  },
  "required": [
    "target",
    "files"
  ]
}
```

**Responses:**

- **200**: Duplicate xet files response
- **207**: Duplicate xet files response

### GET /api/models/{namespace}/{repo}/commits/{rev}

**List commits**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| p | query | integer | No |  |
| expand | query | array | No |  |
| limit | query | integer | No |  |

**Responses:**

- **200**: Commits list

### GET /api/models/{namespace}/{repo}/refs

**List references**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| include_prs | query | string | No |  |

**Responses:**

- **200**: List of references in the repository

### GET /api/models/{namespace}/{repo}/compare/{compare}

**Get a compare rev**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| compare | path | string | Yes |  |
| raw | query | string | No |  |

**Responses:**

- **200**: The diff between the two revisions

### POST /api/models/{namespace}/{repo}/paths-info/{rev}

**List paths info**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "paths": {
      "anyOf": [
        {
          "maxItems": 2000,
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "type": "string"
        }
      ]
    },
    "expand": {
      "description": "Expand the response with the last commit and security file status",
      "anyOf": [
        {
          "default": false
        },
        {
          "default": false,
          "type": "boolean"
        }
      ]
    }
  },
  "required": [
    "paths",
    "expand"
  ]
}
```

**Responses:**

- **200**: List of paths in the repository

### POST /api/models/{namespace}/{repo}/preupload/{rev}

**Check upload method**

Check if a file should be uploaded through the Large File mechanism or directly.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "files": {
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "size": {
            "type": "number"
          },
          "sample": {
            "type": "string"
          }
        },
        "required": [
          "path",
          "size",
          "sample"
        ]
      }
    },
    "gitAttributes": {
      "description": "Provide this parameter if you plan to modify `.gitattributes` yourself at the same time as uploading LFS files. Note that this is not needed if you solely rely on automatic LFS detection from HF: the commit endpoint will automatically edit the `.gitattributes` file to track the files passed to its `lfsFiles` param.",
      "type": "string"
    },
    "gitIgnore": {
      "description": "Content of the .gitignore file for the revision. Optional, otherwise takes the existing content of `.gitignore` for the revision.",
      "type": "string"
    }
  },
  "required": [
    "files"
  ]
}
```

**Responses:**

- **200**: Files to be uploaded.
- **422**: The request is invalid

### GET /api/models/{namespace}/{repo}/xet-write-token/{rev}

**Xet write token**

Get a write short-lived access token for XET upload

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Responses:**

- **200**: The response from the getXetWriteAccessToken endpoint.

### GET /api/models/{namespace}/{repo}/xet-read-token/{rev}

**Xet read token**

Get a read short-lived access token for XET

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Responses:**

- **200**: The response from the getXetReadAccessToken endpoint.

### POST /api/models/{namespace}/{repo}/commit/{rev}

**Commit**

For legacy reason, we support both `application/json` and `application/x-ndjson` but we recommend using `application/x-ndjson` to create a commit.

JSON-lines payload:
```json
{
  "key": "header",
  "value": {
    "summary": "string (REQUIRED)",
    "description": "string (OPTIONAL - defaults to empty string)",
    "parentCommit": "string (OPTIONAL - 40-character hex SHA)"
  }
}
{
  "key": "file",
  "value": {
    "path": "string (REQUIRED)",
    "content": "string (OPTIONAL - required if oldPath not set)",
    "encoding": "utf-8 | base64 (OPTIONAL - defaults to utf-8)",
    "oldPath": "string (OPTIONAL - for move/rename operations)"
  }
}
{
  "key": "deletedEntry",
  "value": {
    "path": "string (REQUIRED)"
  }
}
{
  "key": "lfsFile",
  "value": {
    "path": "string (REQUIRED - max 1000 chars)",
    "oid": "string (OPTIONAL - required if oldPath not set, 64 hex chars)",
    "algo": "sha256 (OPTIONAL - only sha256 supported)",
    "size": "number (OPTIONAL - required if oldPath is set)",
    "oldPath": "string (OPTIONAL - for move/rename operations)"
  }
}
```

JSON payload:
```json
{
  "summary": "string (REQUIRED)",
  "description": "string (OPTIONAL - defaults to empty string)",
  "parentCommit": "string (OPTIONAL - 40-character hex SHA)"
  "files": [
    {
      "path": "string (REQUIRED)",
      "content": "string (OPTIONAL - required if oldPath not set)",
      "encoding": "utf-8 | base64 (OPTIONAL - defaults to utf-8)",
      "oldPath": "string (OPTIONAL - for move/rename operations)"
    }
  ],
  "deletedEntries": [
    {
      "path": "string (REQUIRED)"
    }
  ],
  "lfsFiles": [
    {
      "path": "string (REQUIRED - max 1000 chars)",
      "oid": "string (OPTIONAL - required if oldPath not set, 64 hex chars)",
      "algo": "sha256 (OPTIONAL - only sha256 supported)",
      "size": "number (OPTIONAL - required if oldPath is set)",
      "oldPath": "string (OPTIONAL - for move/rename operations)"
    }
  ]
}
```


**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| create_pr | query | string | No | Whether to create a pull request from the commit |
| hot_reload | query | string | No | For Spaces, whether to try to hot reload the commit (only for single python files updates) |
| Content-Type | header | application/json \| application/x-ndjson | No | `application/x-ndjson` if you to commit by json lines |

**Responses:**

- **200**: The response of the commit

### POST /api/models/{namespace}/{repo}/tag/{rev}

**Create tag**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "tag": {
      "type": "string"
    },
    "message": {
      "type": "string"
    }
  },
  "required": [
    "tag"
  ]
}
```

### DELETE /api/models/{namespace}/{repo}/tag/{rev}

**Delete a tag**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

### POST /api/models/{namespace}/{repo}/branch/{rev}

**Create branch**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "startingPoint": {
      "description": "The commit to start from",
      "type": "string"
    },
    "emptyBranch": {
      "description": "Create an empty branch",
      "default": false,
      "type": "boolean"
    },
    "overwrite": {
      "description": "Overwrite the branch if it already exists",
      "default": false,
      "type": "boolean"
    }
  }
}
```

### DELETE /api/models/{namespace}/{repo}/branch/{rev}

**Delete a branch**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

### POST /api/models/{namespace}/{repo}/resource-group

**Add resource group**

Add the repository to a resource group

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "resourceGroupId": {
      "description": "The resource group to add the repository to, if null, the repository will be removed from the resource group",
      "anyOf": [
        {
          "type": "string",
          "minLength": 24,
          "maxLength": 24,
          "pattern": "^[0-9a-f]{24}$"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "resourceGroupId"
  ]
}
```

**Responses:**

- **200**: Minimal information about the repository

### GET /api/models/{namespace}/{repo}/resource-group

**Get resource group**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The resource group of the repository

### POST /api/models/{namespace}/{repo}/super-squash/{rev}

**Squash ref**

Squash all commits in the current ref into a single commit with the given message. Action is irreversible.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "maxLength": 500
    }
  }
}
```

**Responses:**

- **200**: Response containing the new commit ID after the squash

### PUT /api/models/{namespace}/{repo}/settings

**Update repo settings**

Update the settings of a repo

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "private": {
      "type": "boolean"
    },
    "visibility": {
      "description": "Repository visibility. `protected` is only supported for Spaces.",
      "enum": [
        "private",
        "public",
        "protected"
      ]
    },
    "discussionsDisabled": {
      "type": "boolean"
    },
    "discussionsSorting": {
      "enum": [
        "recently-created",
        "trending",
        "reactions"
      ]
    },
    "gated": {
      "anyOf": [
        {
          "const": false
        },
        {
          "enum": [
            "auto",
            "manual"
          ]
        }
      ]
    },
    "orgMembersGated": {
      "description": "If true, members of the owning org (except admins) must also go through the gated access-request flow.",
      "type": "boolean"
    },
    "gatedNotificationsEmail": {
      "type": "string",
      "format": "email",
      "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "gatedNotificationsMode": {
      "enum": [
        "bulk",
        "real-time"
      ]
    }
  }
}
```

**Responses:**

- **200**: The updated repo settings.

### GET /api/models/{namespace}/{repo}/tree/{rev}/{path}

**List folder content**

List the content of a repository tree, with pagination support.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| expand | query | string | No | If true, returns returns associated commit data for each entry and security scanner metadata. |
| recursive | query | string | No | If true, returns the tree recursively. |
| limit | query | integer | No | 1.000 by default, 100 by default for expand=true |
| cursor | query | string | No |  |

**Responses:**

- **200**: List of entries in the repository tree

### GET /api/models/{namespace}/{repo}/notebook/{rev}/{path}

**Get notebook URL**

Get a jupyter notebook URL for the requested file

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |

**Responses:**

- **200**: Response containing the url of the notebook

### GET /api/models/{namespace}/{repo}/scan

**Get security status**

Get the security status of a repo

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The security status of the repo

### GET /api/models/{namespace}/{repo}/jwt

**Generate JWT**

Generate a JWT token for accessing a repository. Supports optional write access for spaces in dev mode, custom expiration, and encryption.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| write | query | string | No |  |
| expiration | query | string | No |  |
| encrypted | query | string | No |  |
| inference_api | query | string | No |  |
| include_pro_status | query | string | No |  |
| billing_details | query | string | No |  |

**Responses:**

- **200**: The JWT token and related information

### GET /api/models-tags-by-type

**Get model tags**

Get all possible tags used for models, grouped by tag type. Optionally restrict to only one tag type

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| type | query | pipeline_tag \| library \| dataset \| bucket \| language \| license \| arxiv \| doi \| region \| other | No |  |

**Responses:**

- **200**: The tags, grouped by tag type

### GET /api/trending

**Get trending**

Get the trending repositories

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| type | query | all \| dataset \| model \| space | No |  |
| limit | query | integer | No |  |

**Responses:**

- **200**: Trending repos

### GET /{namespace}/{repo}/resolve/{rev}/{path}

**Resolve a file**

This endpoint requires to follow redirection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| Range | header | string | No | The range in bytes of the file to download |
| Accept | header | string | No | Returns json information about the XET file info - if the file is a xet file |

**Responses:**

- **200**: The XET file info only available if the accept header is set to application/vnd.xet-fileinfo+json
- **302**: Redirection to file
- **304**: Not modified
- **307**: Redirection to Xet endpoint

### GET /api/resolve-cache/models/{namespace}/{repo}/{rev}/{path}

**Resolve a file**

This endpoint requires to follow redirection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| Range | header | string | No | The range in bytes of the file to download |
| Accept | header | string | No | Returns json information about the XET file info - if the file is a xet file |

**Responses:**

- **200**: The XET file info only available if the accept header is set to application/vnd.xet-fileinfo+json
- **302**: Redirection to file
- **304**: Not modified
- **307**: Redirection to Xet endpoint

### POST /{namespace}/{repo}/ask-access

**Request access**

Request access to a gated repository. The fields requested by repository card metadata (https://huggingface.co/docs/hub/en/models-gated#customize-requested-information)

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "propertyNames": {
    "type": "string"
  },
  "additionalProperties": {}
}
```

**Responses:**

- **303**: Redirection to the repo

### GET /{namespace}/{repo}/user-access-report

**Export access report**

Export a report of all access requests for a gated repository

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The report of all access requests for a gated repository

### POST /api/models/{namespace}/{repo}/user-access-request/cancel

**Cancel access request**

Cancel the current user's access request to a gated repository

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

### GET /api/models/{namespace}/{repo}/user-access-request/{status}

**List access requests**

List access requests for a gated repository

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| status | path | string | Yes |  |
| limit | query | integer | No |  |
| after | query | string | No |  |
| before | query | string | No |  |

**Responses:**

- **200**: List of access requests for the gated repository

### POST /api/models/{namespace}/{repo}/user-access-request/handle

**Handle access request**

Handle a user's access request to a gated repository

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "description": "Either userId or user must be provided",
      "type": "string",
      "minLength": 24,
      "maxLength": 24,
      "pattern": "^[0-9a-f]{24}$"
    },
    "user": {
      "description": "Either userId or user must be provided",
      "type": "string"
    },
    "status": {
      "enum": [
        "accepted",
        "rejected",
        "pending"
      ]
    },
    "rejectionReason": {
      "type": "string",
      "maxLength": 200
    }
  },
  "required": [
    "status"
  ]
}
```

### POST /api/models/{namespace}/{repo}/user-access-request/batch

**Handle access requests in batch**

Accept or reject up to 100 access requests for a single gated repository in one call. The same `status` (and optional `rejectionReason`) is applied to every request in the list.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "status": {
      "enum": [
        "accepted",
        "rejected"
      ]
    },
    "rejectionReason": {
      "type": "string",
      "maxLength": 200
    },
    "requests": {
      "minItems": 1,
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "userId": {
            "description": "Either userId or user must be provided",
            "type": "string",
            "minLength": 24,
            "maxLength": 24,
            "pattern": "^[0-9a-f]{24}$"
          },
          "user": {
            "description": "Either userId or user must be provided",
            "type": "string"
          }
        }
      }
    }
  },
  "required": [
    "status",
    "requests"
  ]
}
```

**Responses:**

- **200**: Per-request outcomes, in the same order as the input requests array.

### POST /api/models/{namespace}/{repo}/user-access-request/grant

**Grant access**

Grant access to a user for a gated repository

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "The user to grant access to either by userId or user",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "minLength": 24,
      "maxLength": 24,
      "pattern": "^[0-9a-f]{24}$"
    },
    "user": {
      "type": "string"
    }
  }
}
```

## Kernels

Get information from all kernels on the Hub.

### POST /api/kernels/{namespace}/{repo}/lfs-files/duplicate

**Duplicate xet files**

Duplicate xet-stored files from this repo (source) into another repo (target) by xet hash, without re-uploading file bytes. The caller must then commit the files with their sha256/size as usual.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "type": {
          "enum": [
            "dataset",
            "model",
            "space",
            "kernel"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "type",
        "name"
      ]
    },
    "files": {
      "minItems": 1,
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "xetHash": {
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-fA-F]{64}$"
          },
          "sha256": {
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-fA-F]{64}$"
          },
          "filename": {
            "type": "string",
            "maxLength": 1000
          }
        },
        "required": [
          "xetHash",
          "sha256"
        ]
      }
    }
  },
  "required": [
    "target",
    "files"
  ]
}
```

**Responses:**

- **200**: Duplicate xet files response
- **207**: Duplicate xet files response

### GET /api/kernels/{namespace}/{repo}

**Get kernel**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: Kernel overview information

### GET /api/kernels/{namespace}/{repo}/revision/{rev}

**Get kernel**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Responses:**

- **200**: Kernel overview information

## Datasets

Get information from all datasets on the Hub.

### GET /api/datasets/{namespace}/{repo}/treesize/{rev}/{path}

**Get folder size**

Get the total size of a repository at a given revision, optionally under a specific subpath. Returns the total size in bytes of all files under the specified path (recursively). If a file is stored via Xet/LFS, the LFS file size is used.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |

**Responses:**

- **200**: Total size of a repository at a given revision, under the given path

### GET /api/datasets/{namespace}/{repo}/lfs-files

**List Large files**

List Xet/LFS files for a repo

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| cursor | query | string | No |  |
| limit | query | integer | No |  |
| xet | query | string | No |  |

**Responses:**

- **200**: List of Xet/LFS files for the repo

### POST /api/datasets/{namespace}/{repo}/lfs-files/batch

**Delete Large files**

Delete Xet/LFS files in batch

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "deletions": {
      "type": "object",
      "properties": {
        "sha": {
          "minItems": 1,
          "maxItems": 1000,
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "rewriteHistory": {
          "default": true,
          "type": "boolean"
        }
      },
      "required": [
        "sha"
      ]
    }
  },
  "required": [
    "deletions"
  ]
}
```

### DELETE /api/datasets/{namespace}/{repo}/lfs-files/{sha}

**Delete Large file**

Delete a Xet/LFS file

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| sha | path | string | Yes |  |
| rewriteHistory | query | string | No |  |

### POST /api/datasets/{namespace}/{repo}/lfs-files/duplicate

**Duplicate xet files**

Duplicate xet-stored files from this repo (source) into another repo (target) by xet hash, without re-uploading file bytes. The caller must then commit the files with their sha256/size as usual.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "type": {
          "enum": [
            "dataset",
            "model",
            "space",
            "kernel"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "type",
        "name"
      ]
    },
    "files": {
      "minItems": 1,
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "xetHash": {
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-fA-F]{64}$"
          },
          "sha256": {
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-fA-F]{64}$"
          },
          "filename": {
            "type": "string",
            "maxLength": 1000
          }
        },
        "required": [
          "xetHash",
          "sha256"
        ]
      }
    }
  },
  "required": [
    "target",
    "files"
  ]
}
```

**Responses:**

- **200**: Duplicate xet files response
- **207**: Duplicate xet files response

### GET /api/datasets/{namespace}/{repo}/commits/{rev}

**List commits**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| p | query | integer | No |  |
| expand | query | array | No |  |
| limit | query | integer | No |  |

**Responses:**

- **200**: Commits list

### GET /api/datasets/{namespace}/{repo}/refs

**List references**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| include_prs | query | string | No |  |

**Responses:**

- **200**: List of references in the repository

### GET /api/datasets/{namespace}/{repo}/compare/{compare}

**Get a compare rev**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| compare | path | string | Yes |  |
| raw | query | string | No |  |

**Responses:**

- **200**: The diff between the two revisions

### POST /api/datasets/{namespace}/{repo}/paths-info/{rev}

**List paths info**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "paths": {
      "anyOf": [
        {
          "maxItems": 2000,
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "type": "string"
        }
      ]
    },
    "expand": {
      "description": "Expand the response with the last commit and security file status",
      "anyOf": [
        {
          "default": false
        },
        {
          "default": false,
          "type": "boolean"
        }
      ]
    }
  },
  "required": [
    "paths",
    "expand"
  ]
}
```

**Responses:**

- **200**: List of paths in the repository

### POST /api/datasets/{namespace}/{repo}/preupload/{rev}

**Check upload method**

Check if a file should be uploaded through the Large File mechanism or directly.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "files": {
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "size": {
            "type": "number"
          },
          "sample": {
            "type": "string"
          }
        },
        "required": [
          "path",
          "size",
          "sample"
        ]
      }
    },
    "gitAttributes": {
      "description": "Provide this parameter if you plan to modify `.gitattributes` yourself at the same time as uploading LFS files. Note that this is not needed if you solely rely on automatic LFS detection from HF: the commit endpoint will automatically edit the `.gitattributes` file to track the files passed to its `lfsFiles` param.",
      "type": "string"
    },
    "gitIgnore": {
      "description": "Content of the .gitignore file for the revision. Optional, otherwise takes the existing content of `.gitignore` for the revision.",
      "type": "string"
    }
  },
  "required": [
    "files"
  ]
}
```

**Responses:**

- **200**: Files to be uploaded.
- **422**: The request is invalid

### GET /api/datasets/{namespace}/{repo}/xet-write-token/{rev}

**Xet write token**

Get a write short-lived access token for XET upload

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Responses:**

- **200**: The response from the getXetWriteAccessToken endpoint.

### GET /api/datasets/{namespace}/{repo}/xet-read-token/{rev}

**Xet read token**

Get a read short-lived access token for XET

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Responses:**

- **200**: The response from the getXetReadAccessToken endpoint.

### POST /api/datasets/{namespace}/{repo}/commit/{rev}

**Commit**

For legacy reason, we support both `application/json` and `application/x-ndjson` but we recommend using `application/x-ndjson` to create a commit.

JSON-lines payload:
```json
{
  "key": "header",
  "value": {
    "summary": "string (REQUIRED)",
    "description": "string (OPTIONAL - defaults to empty string)",
    "parentCommit": "string (OPTIONAL - 40-character hex SHA)"
  }
}
{
  "key": "file",
  "value": {
    "path": "string (REQUIRED)",
    "content": "string (OPTIONAL - required if oldPath not set)",
    "encoding": "utf-8 | base64 (OPTIONAL - defaults to utf-8)",
    "oldPath": "string (OPTIONAL - for move/rename operations)"
  }
}
{
  "key": "deletedEntry",
  "value": {
    "path": "string (REQUIRED)"
  }
}
{
  "key": "lfsFile",
  "value": {
    "path": "string (REQUIRED - max 1000 chars)",
    "oid": "string (OPTIONAL - required if oldPath not set, 64 hex chars)",
    "algo": "sha256 (OPTIONAL - only sha256 supported)",
    "size": "number (OPTIONAL - required if oldPath is set)",
    "oldPath": "string (OPTIONAL - for move/rename operations)"
  }
}
```

JSON payload:
```json
{
  "summary": "string (REQUIRED)",
  "description": "string (OPTIONAL - defaults to empty string)",
  "parentCommit": "string (OPTIONAL - 40-character hex SHA)"
  "files": [
    {
      "path": "string (REQUIRED)",
      "content": "string (OPTIONAL - required if oldPath not set)",
      "encoding": "utf-8 | base64 (OPTIONAL - defaults to utf-8)",
      "oldPath": "string (OPTIONAL - for move/rename operations)"
    }
  ],
  "deletedEntries": [
    {
      "path": "string (REQUIRED)"
    }
  ],
  "lfsFiles": [
    {
      "path": "string (REQUIRED - max 1000 chars)",
      "oid": "string (OPTIONAL - required if oldPath not set, 64 hex chars)",
      "algo": "sha256 (OPTIONAL - only sha256 supported)",
      "size": "number (OPTIONAL - required if oldPath is set)",
      "oldPath": "string (OPTIONAL - for move/rename operations)"
    }
  ]
}
```


**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| create_pr | query | string | No | Whether to create a pull request from the commit |
| hot_reload | query | string | No | For Spaces, whether to try to hot reload the commit (only for single python files updates) |
| Content-Type | header | application/json \| application/x-ndjson | No | `application/x-ndjson` if you to commit by json lines |

**Responses:**

- **200**: The response of the commit

### POST /api/datasets/{namespace}/{repo}/tag/{rev}

**Create tag**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "tag": {
      "type": "string"
    },
    "message": {
      "type": "string"
    }
  },
  "required": [
    "tag"
  ]
}
```

### DELETE /api/datasets/{namespace}/{repo}/tag/{rev}

**Delete a tag**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

### POST /api/datasets/{namespace}/{repo}/branch/{rev}

**Create branch**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "startingPoint": {
      "description": "The commit to start from",
      "type": "string"
    },
    "emptyBranch": {
      "description": "Create an empty branch",
      "default": false,
      "type": "boolean"
    },
    "overwrite": {
      "description": "Overwrite the branch if it already exists",
      "default": false,
      "type": "boolean"
    }
  }
}
```

### DELETE /api/datasets/{namespace}/{repo}/branch/{rev}

**Delete a branch**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

### POST /api/datasets/{namespace}/{repo}/resource-group

**Add resource group**

Add the repository to a resource group

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "resourceGroupId": {
      "description": "The resource group to add the repository to, if null, the repository will be removed from the resource group",
      "anyOf": [
        {
          "type": "string",
          "minLength": 24,
          "maxLength": 24,
          "pattern": "^[0-9a-f]{24}$"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "resourceGroupId"
  ]
}
```

**Responses:**

- **200**: Minimal information about the repository

### GET /api/datasets/{namespace}/{repo}/resource-group

**Get resource group**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The resource group of the repository

### POST /api/datasets/{namespace}/{repo}/super-squash/{rev}

**Squash ref**

Squash all commits in the current ref into a single commit with the given message. Action is irreversible.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "maxLength": 500
    }
  }
}
```

**Responses:**

- **200**: Response containing the new commit ID after the squash

### PUT /api/datasets/{namespace}/{repo}/settings

**Update repo settings**

Update the settings of a repo

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "private": {
      "type": "boolean"
    },
    "visibility": {
      "description": "Repository visibility. `protected` is only supported for Spaces.",
      "enum": [
        "private",
        "public",
        "protected"
      ]
    },
    "discussionsDisabled": {
      "type": "boolean"
    },
    "discussionsSorting": {
      "enum": [
        "recently-created",
        "trending",
        "reactions"
      ]
    },
    "gated": {
      "anyOf": [
        {
          "const": false
        },
        {
          "enum": [
            "auto",
            "manual"
          ]
        }
      ]
    },
    "orgMembersGated": {
      "description": "If true, members of the owning org (except admins) must also go through the gated access-request flow.",
      "type": "boolean"
    },
    "gatedNotificationsEmail": {
      "type": "string",
      "format": "email",
      "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "gatedNotificationsMode": {
      "enum": [
        "bulk",
        "real-time"
      ]
    }
  }
}
```

**Responses:**

- **200**: The updated repo settings.

### GET /api/datasets/{namespace}/{repo}/tree/{rev}/{path}

**List folder content**

List the content of a repository tree, with pagination support.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| expand | query | string | No | If true, returns returns associated commit data for each entry and security scanner metadata. |
| recursive | query | string | No | If true, returns the tree recursively. |
| limit | query | integer | No | 1.000 by default, 100 by default for expand=true |
| cursor | query | string | No |  |

**Responses:**

- **200**: List of entries in the repository tree

### GET /api/datasets/{namespace}/{repo}/notebook/{rev}/{path}

**Get notebook URL**

Get a jupyter notebook URL for the requested file

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |

**Responses:**

- **200**: Response containing the url of the notebook

### GET /api/datasets/{namespace}/{repo}/scan

**Get security status**

Get the security status of a repo

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The security status of the repo

### GET /api/datasets/{namespace}/{repo}/leaderboard

**Get the leaderboard for a dataset**

Returns the evaluation results ranked by score for a dataset/task

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| task_id | query | string | No |  |
| max_params | query | string | No |  |

**Responses:**

- **200**: Evaluation results

### GET /api/datasets/{namespace}/{repo}/jwt

**Generate JWT**

Generate a JWT token for accessing a repository. Supports optional write access for spaces in dev mode, custom expiration, and encryption.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| write | query | string | No |  |
| expiration | query | string | No |  |
| encrypted | query | string | No |  |
| inference_api | query | string | No |  |
| include_pro_status | query | string | No |  |
| billing_details | query | string | No |  |

**Responses:**

- **200**: The JWT token and related information

### GET /api/datasets-tags-by-type

**Get dataset tags**

Get all possible tags used for datasets, grouped by tag type. Optionally restrict to only one tag type

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| type | query | benchmark \| task_categories \| size_categories \| modality \| format \| library \| language \| license \| arxiv \| doi \| region \| other \| task_ids \| annotations_creators \| language_creators \| multilinguality \| source_datasets | No |  |

**Responses:**

- **200**: The tags, grouped by tag type

### GET /api/trending

**Get trending**

Get the trending repositories

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| type | query | all \| dataset \| model \| space | No |  |
| limit | query | integer | No |  |

**Responses:**

- **200**: Trending repos

### GET /datasets/{namespace}/{repo}/resolve/{rev}/{path}

**Resolve a file**

This endpoint requires to follow redirection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| Range | header | string | No | The range in bytes of the file to download |
| Accept | header | string | No | Returns json information about the XET file info - if the file is a xet file |

**Responses:**

- **200**: The XET file info only available if the accept header is set to application/vnd.xet-fileinfo+json
- **302**: Redirection to file
- **304**: Not modified
- **307**: Redirection to Xet endpoint

### GET /api/resolve-cache/datasets/{namespace}/{repo}/{rev}/{path}

**Resolve a file**

This endpoint requires to follow redirection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| Range | header | string | No | The range in bytes of the file to download |
| Accept | header | string | No | Returns json information about the XET file info - if the file is a xet file |

**Responses:**

- **200**: The XET file info only available if the accept header is set to application/vnd.xet-fileinfo+json
- **302**: Redirection to file
- **304**: Not modified
- **307**: Redirection to Xet endpoint

### POST /datasets/{namespace}/{repo}/ask-access

**Request access**

Request access to a gated repository. The fields requested by repository card metadata (https://huggingface.co/docs/hub/en/models-gated#customize-requested-information)

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "propertyNames": {
    "type": "string"
  },
  "additionalProperties": {}
}
```

**Responses:**

- **303**: Redirection to the repo

### GET /datasets/{namespace}/{repo}/user-access-report

**Export access report**

Export a report of all access requests for a gated repository

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The report of all access requests for a gated repository

### POST /api/datasets/{namespace}/{repo}/user-access-request/cancel

**Cancel access request**

Cancel the current user's access request to a gated repository

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

### GET /api/datasets/{namespace}/{repo}/user-access-request/{status}

**List access requests**

List access requests for a gated repository

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| status | path | string | Yes |  |
| limit | query | integer | No |  |
| after | query | string | No |  |
| before | query | string | No |  |

**Responses:**

- **200**: List of access requests for the gated repository

### POST /api/datasets/{namespace}/{repo}/user-access-request/handle

**Handle access request**

Handle a user's access request to a gated repository

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "userId": {
      "description": "Either userId or user must be provided",
      "type": "string",
      "minLength": 24,
      "maxLength": 24,
      "pattern": "^[0-9a-f]{24}$"
    },
    "user": {
      "description": "Either userId or user must be provided",
      "type": "string"
    },
    "status": {
      "enum": [
        "accepted",
        "rejected",
        "pending"
      ]
    },
    "rejectionReason": {
      "type": "string",
      "maxLength": 200
    }
  },
  "required": [
    "status"
  ]
}
```

### POST /api/datasets/{namespace}/{repo}/user-access-request/batch

**Handle access requests in batch**

Accept or reject up to 100 access requests for a single gated repository in one call. The same `status` (and optional `rejectionReason`) is applied to every request in the list.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "status": {
      "enum": [
        "accepted",
        "rejected"
      ]
    },
    "rejectionReason": {
      "type": "string",
      "maxLength": 200
    },
    "requests": {
      "minItems": 1,
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "userId": {
            "description": "Either userId or user must be provided",
            "type": "string",
            "minLength": 24,
            "maxLength": 24,
            "pattern": "^[0-9a-f]{24}$"
          },
          "user": {
            "description": "Either userId or user must be provided",
            "type": "string"
          }
        }
      }
    }
  },
  "required": [
    "status",
    "requests"
  ]
}
```

**Responses:**

- **200**: Per-request outcomes, in the same order as the input requests array.

### POST /api/datasets/{namespace}/{repo}/user-access-request/grant

**Grant access**

Grant access to a user for a gated repository

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "The user to grant access to either by userId or user",
  "type": "object",
  "properties": {
    "userId": {
      "type": "string",
      "minLength": 24,
      "maxLength": 24,
      "pattern": "^[0-9a-f]{24}$"
    },
    "user": {
      "type": "string"
    }
  }
}
```

## SQL Console

Get information from SQL Console embeds from a dataset.

### PATCH /api/{repoType}/{namespace}/{repo}/sql-console/embed/{id}

**Update embed**

Update SQL Console embed

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| id | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "maxLength": 200
    },
    "private": {
      "type": "boolean"
    },
    "sql": {
      "type": "string"
    }
  }
}
```

**Responses:**

- **200**: Updated SQL console embed

### DELETE /api/{repoType}/{namespace}/{repo}/sql-console/embed/{id}

**Delete embed**

Delete SQL Console embed

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| id | path | string | Yes |  |

**Responses:**

- **204**: SQL console embed deleted successfully

### POST /api/{repoType}/{namespace}/{repo}/sql-console/embed

**Create embed**

Create SQL Console embed

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sql": {
      "type": "string"
    },
    "title": {
      "type": "string",
      "maxLength": 200
    },
    "private": {
      "type": "boolean"
    },
    "views": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string"
          },
          "displayName": {
            "type": "string"
          },
          "viewName": {
            "type": "string"
          }
        },
        "required": [
          "key",
          "displayName",
          "viewName"
        ]
      }
    }
  },
  "required": [
    "sql",
    "title",
    "views"
  ]
}
```

**Responses:**

- **200**: Created SQL console embed

## Discussions

The following endpoints manage discussions.

### POST /api/blog/{slug}/comment

**Create a new comment**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| slug | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "comment": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  },
  "required": [
    "comment"
  ]
}
```

**Responses:**

- **201**: New comment created

### POST /api/blog/{slug}/comment/{commentId}/reply

**Create a new comment**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| slug | path | string | Yes |  |
| commentId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "comment": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  },
  "required": [
    "comment"
  ]
}
```

**Responses:**

- **201**: New comment created

### POST /api/blog/{namespace}/{slug}/comment

**Create a new comment**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "comment": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  },
  "required": [
    "comment"
  ]
}
```

**Responses:**

- **201**: New comment created

### POST /api/blog/{namespace}/{slug}/comment/{commentId}/reply

**Create a new comment**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |
| commentId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "comment": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  },
  "required": [
    "comment"
  ]
}
```

**Responses:**

- **201**: New comment created

### GET /api/{repoType}/{namespace}/{repo}/discussions

**List discussions**

Get discussions for a repo

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| p | query | integer | No |  |
| type | query | all \| discussion \| pull_request | No |  |
| status | query | all \| open \| closed | No |  |
| author | query | string | No |  |
| search | query | string | No |  |
| sort | query | recently-created \| trending \| reactions | No |  |

**Responses:**

- **200**: List of discussions

### POST /api/{repoType}/{namespace}/{repo}/discussions

**Create a new discussion**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 3,
      "maxLength": 200
    },
    "description": {
      "type": "string",
      "maxLength": 65536
    },
    "pullRequest": {
      "type": "boolean"
    }
  },
  "required": [
    "title",
    "description"
  ]
}
```

**Responses:**

- **200**: Discussion creation response

### GET /api/{repoType}/{namespace}/{repo}/discussions/{num}

**Get discussion details**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| num | path | string | Yes |  |

**Responses:**

- **200**: Discussion details

### DELETE /api/{repoType}/{namespace}/{repo}/discussions/{num}

**Delete a discussion**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| num | path | string | Yes |  |

### POST /api/{repoType}/{namespace}/{repo}/discussions/{num}/comment

**Create a new comment**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| num | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "comment": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  },
  "required": [
    "comment"
  ]
}
```

**Responses:**

- **201**: New comment created

### POST /api/{repoType}/{namespace}/{repo}/discussions/{num}/status

**Change status**

Change the status of a discussion

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| num | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "status": {
      "enum": [
        "open",
        "closed"
      ]
    },
    "comment": {
      "type": "string"
    }
  },
  "required": [
    "status"
  ]
}
```

**Responses:**

- **200**: New status event

### POST /api/{repoType}/{namespace}/{repo}/discussions/{num}/title

**Change title**

Change the title of a discussion

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| num | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 3,
      "maxLength": 200
    }
  },
  "required": [
    "title"
  ]
}
```

**Responses:**

- **200**: New title event

### POST /api/{repoType}/{namespace}/{repo}/discussions/{num}/pin

**Pin a discussion**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| num | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pinned": {
      "type": "boolean"
    }
  },
  "required": [
    "pinned"
  ]
}
```

### POST /api/{repoType}/{namespace}/{repo}/discussions/{num}/merge

**Merge a pull request**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| num | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "comment": {
      "type": "string"
    }
  }
}
```

### DELETE /api/{repoType}/{namespace}/{repo}/discussions/{num}/ref

**Delete PR ref**

Deletes the git ref for a closed/merged pull request to free up storage. LFS files unique to this PR will be garbage collected. The PR page and diff will still be viewable using stored commit data.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| num | path | string | Yes |  |

### GET /api/{repoType}/{namespace}/{repo}/discussions/{num}/storage

**PR storage estimate**

Estimates the LFS storage used by a PR that could be freed if the ref is deleted.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| num | path | string | Yes |  |

**Responses:**

- **200**: PR storage estimate response

### POST /api/papers/{paperId}/comment

**Create a new comment**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| paperId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "comment": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  },
  "required": [
    "comment"
  ]
}
```

**Responses:**

- **201**: New comment created

### POST /api/papers/{paperId}/comment/{commentId}/reply

**Create a new comment**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| paperId | path | string | Yes |  |
| commentId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "comment": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  },
  "required": [
    "comment"
  ]
}
```

**Responses:**

- **201**: New comment created

### DELETE /api/posts/{username}/{postSlug}

**Delete a discussion**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| username | path | string | Yes |  |
| postSlug | path | string | Yes |  |

### POST /api/posts/{username}/{postSlug}/comment

**Create a new comment**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| username | path | string | Yes |  |
| postSlug | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "comment": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  },
  "required": [
    "comment"
  ]
}
```

**Responses:**

- **201**: New comment created

### POST /api/posts/{username}/{postSlug}/comment/{commentId}/reply

**Create a new comment**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| username | path | string | Yes |  |
| postSlug | path | string | Yes |  |
| commentId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "comment": {
      "type": "string",
      "minLength": 1,
      "maxLength": 65536
    }
  },
  "required": [
    "comment"
  ]
}
```

**Responses:**

- **201**: New comment created

## Spaces

Get information from all Spaces on the Hub.

### GET /api/spaces/{namespace}/{repo}/treesize/{rev}/{path}

**Get folder size**

Get the total size of a repository at a given revision, optionally under a specific subpath. Returns the total size in bytes of all files under the specified path (recursively). If a file is stored via Xet/LFS, the LFS file size is used.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |

**Responses:**

- **200**: Total size of a repository at a given revision, under the given path

### GET /api/spaces/{namespace}/{repo}/lfs-files

**List Large files**

List Xet/LFS files for a repo

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| cursor | query | string | No |  |
| limit | query | integer | No |  |
| xet | query | string | No |  |

**Responses:**

- **200**: List of Xet/LFS files for the repo

### POST /api/spaces/{namespace}/{repo}/lfs-files/batch

**Delete Large files**

Delete Xet/LFS files in batch

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "deletions": {
      "type": "object",
      "properties": {
        "sha": {
          "minItems": 1,
          "maxItems": 1000,
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "rewriteHistory": {
          "default": true,
          "type": "boolean"
        }
      },
      "required": [
        "sha"
      ]
    }
  },
  "required": [
    "deletions"
  ]
}
```

### DELETE /api/spaces/{namespace}/{repo}/lfs-files/{sha}

**Delete Large file**

Delete a Xet/LFS file

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| sha | path | string | Yes |  |
| rewriteHistory | query | string | No |  |

### POST /api/spaces/{namespace}/{repo}/lfs-files/duplicate

**Duplicate xet files**

Duplicate xet-stored files from this repo (source) into another repo (target) by xet hash, without re-uploading file bytes. The caller must then commit the files with their sha256/size as usual.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "type": {
          "enum": [
            "dataset",
            "model",
            "space",
            "kernel"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "type",
        "name"
      ]
    },
    "files": {
      "minItems": 1,
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "xetHash": {
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-fA-F]{64}$"
          },
          "sha256": {
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-fA-F]{64}$"
          },
          "filename": {
            "type": "string",
            "maxLength": 1000
          }
        },
        "required": [
          "xetHash",
          "sha256"
        ]
      }
    }
  },
  "required": [
    "target",
    "files"
  ]
}
```

**Responses:**

- **200**: Duplicate xet files response
- **207**: Duplicate xet files response

### GET /api/spaces/{namespace}/{repo}/commits/{rev}

**List commits**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| p | query | integer | No |  |
| expand | query | array | No |  |
| limit | query | integer | No |  |

**Responses:**

- **200**: Commits list

### GET /api/spaces/{namespace}/{repo}/refs

**List references**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| include_prs | query | string | No |  |

**Responses:**

- **200**: List of references in the repository

### GET /api/spaces/{namespace}/{repo}/compare/{compare}

**Get a compare rev**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| compare | path | string | Yes |  |
| raw | query | string | No |  |

**Responses:**

- **200**: The diff between the two revisions

### POST /api/spaces/{namespace}/{repo}/paths-info/{rev}

**List paths info**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "paths": {
      "anyOf": [
        {
          "maxItems": 2000,
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "type": "string"
        }
      ]
    },
    "expand": {
      "description": "Expand the response with the last commit and security file status",
      "anyOf": [
        {
          "default": false
        },
        {
          "default": false,
          "type": "boolean"
        }
      ]
    }
  },
  "required": [
    "paths",
    "expand"
  ]
}
```

**Responses:**

- **200**: List of paths in the repository

### POST /api/spaces/{namespace}/{repo}/preupload/{rev}

**Check upload method**

Check if a file should be uploaded through the Large File mechanism or directly.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "files": {
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "size": {
            "type": "number"
          },
          "sample": {
            "type": "string"
          }
        },
        "required": [
          "path",
          "size",
          "sample"
        ]
      }
    },
    "gitAttributes": {
      "description": "Provide this parameter if you plan to modify `.gitattributes` yourself at the same time as uploading LFS files. Note that this is not needed if you solely rely on automatic LFS detection from HF: the commit endpoint will automatically edit the `.gitattributes` file to track the files passed to its `lfsFiles` param.",
      "type": "string"
    },
    "gitIgnore": {
      "description": "Content of the .gitignore file for the revision. Optional, otherwise takes the existing content of `.gitignore` for the revision.",
      "type": "string"
    }
  },
  "required": [
    "files"
  ]
}
```

**Responses:**

- **200**: Files to be uploaded.
- **422**: The request is invalid

### GET /api/spaces/{namespace}/{repo}/xet-write-token/{rev}

**Xet write token**

Get a write short-lived access token for XET upload

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Responses:**

- **200**: The response from the getXetWriteAccessToken endpoint.

### GET /api/spaces/{namespace}/{repo}/xet-read-token/{rev}

**Xet read token**

Get a read short-lived access token for XET

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Responses:**

- **200**: The response from the getXetReadAccessToken endpoint.

### POST /api/spaces/{namespace}/{repo}/commit/{rev}

**Commit**

For legacy reason, we support both `application/json` and `application/x-ndjson` but we recommend using `application/x-ndjson` to create a commit.

JSON-lines payload:
```json
{
  "key": "header",
  "value": {
    "summary": "string (REQUIRED)",
    "description": "string (OPTIONAL - defaults to empty string)",
    "parentCommit": "string (OPTIONAL - 40-character hex SHA)"
  }
}
{
  "key": "file",
  "value": {
    "path": "string (REQUIRED)",
    "content": "string (OPTIONAL - required if oldPath not set)",
    "encoding": "utf-8 | base64 (OPTIONAL - defaults to utf-8)",
    "oldPath": "string (OPTIONAL - for move/rename operations)"
  }
}
{
  "key": "deletedEntry",
  "value": {
    "path": "string (REQUIRED)"
  }
}
{
  "key": "lfsFile",
  "value": {
    "path": "string (REQUIRED - max 1000 chars)",
    "oid": "string (OPTIONAL - required if oldPath not set, 64 hex chars)",
    "algo": "sha256 (OPTIONAL - only sha256 supported)",
    "size": "number (OPTIONAL - required if oldPath is set)",
    "oldPath": "string (OPTIONAL - for move/rename operations)"
  }
}
```

JSON payload:
```json
{
  "summary": "string (REQUIRED)",
  "description": "string (OPTIONAL - defaults to empty string)",
  "parentCommit": "string (OPTIONAL - 40-character hex SHA)"
  "files": [
    {
      "path": "string (REQUIRED)",
      "content": "string (OPTIONAL - required if oldPath not set)",
      "encoding": "utf-8 | base64 (OPTIONAL - defaults to utf-8)",
      "oldPath": "string (OPTIONAL - for move/rename operations)"
    }
  ],
  "deletedEntries": [
    {
      "path": "string (REQUIRED)"
    }
  ],
  "lfsFiles": [
    {
      "path": "string (REQUIRED - max 1000 chars)",
      "oid": "string (OPTIONAL - required if oldPath not set, 64 hex chars)",
      "algo": "sha256 (OPTIONAL - only sha256 supported)",
      "size": "number (OPTIONAL - required if oldPath is set)",
      "oldPath": "string (OPTIONAL - for move/rename operations)"
    }
  ]
}
```


**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| create_pr | query | string | No | Whether to create a pull request from the commit |
| hot_reload | query | string | No | For Spaces, whether to try to hot reload the commit (only for single python files updates) |
| Content-Type | header | application/json \| application/x-ndjson | No | `application/x-ndjson` if you to commit by json lines |

**Responses:**

- **200**: The response of the commit

### POST /api/spaces/{namespace}/{repo}/tag/{rev}

**Create tag**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "tag": {
      "type": "string"
    },
    "message": {
      "type": "string"
    }
  },
  "required": [
    "tag"
  ]
}
```

### DELETE /api/spaces/{namespace}/{repo}/tag/{rev}

**Delete a tag**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

### POST /api/spaces/{namespace}/{repo}/branch/{rev}

**Create branch**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "startingPoint": {
      "description": "The commit to start from",
      "type": "string"
    },
    "emptyBranch": {
      "description": "Create an empty branch",
      "default": false,
      "type": "boolean"
    },
    "overwrite": {
      "description": "Overwrite the branch if it already exists",
      "default": false,
      "type": "boolean"
    }
  }
}
```

### DELETE /api/spaces/{namespace}/{repo}/branch/{rev}

**Delete a branch**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

### POST /api/spaces/{namespace}/{repo}/resource-group

**Add resource group**

Add the repository to a resource group

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "resourceGroupId": {
      "description": "The resource group to add the repository to, if null, the repository will be removed from the resource group",
      "anyOf": [
        {
          "type": "string",
          "minLength": 24,
          "maxLength": 24,
          "pattern": "^[0-9a-f]{24}$"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "resourceGroupId"
  ]
}
```

**Responses:**

- **200**: Minimal information about the repository

### GET /api/spaces/{namespace}/{repo}/resource-group

**Get resource group**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The resource group of the repository

### POST /api/spaces/{namespace}/{repo}/super-squash/{rev}

**Squash ref**

Squash all commits in the current ref into a single commit with the given message. Action is irreversible.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "maxLength": 500
    }
  }
}
```

**Responses:**

- **200**: Response containing the new commit ID after the squash

### PUT /api/spaces/{namespace}/{repo}/settings

**Update repo settings**

Update the settings of a repo

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "private": {
      "type": "boolean"
    },
    "visibility": {
      "description": "Repository visibility. `protected` is only supported for Spaces.",
      "enum": [
        "private",
        "public",
        "protected"
      ]
    },
    "discussionsDisabled": {
      "type": "boolean"
    },
    "discussionsSorting": {
      "enum": [
        "recently-created",
        "trending",
        "reactions"
      ]
    },
    "gated": {
      "anyOf": [
        {
          "const": false
        },
        {
          "enum": [
            "auto",
            "manual"
          ]
        }
      ]
    },
    "orgMembersGated": {
      "description": "If true, members of the owning org (except admins) must also go through the gated access-request flow.",
      "type": "boolean"
    },
    "gatedNotificationsEmail": {
      "type": "string",
      "format": "email",
      "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "gatedNotificationsMode": {
      "enum": [
        "bulk",
        "real-time"
      ]
    }
  }
}
```

**Responses:**

- **200**: The updated repo settings.

### GET /api/spaces/{namespace}/{repo}/tree/{rev}/{path}

**List folder content**

List the content of a repository tree, with pagination support.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| expand | query | string | No | If true, returns returns associated commit data for each entry and security scanner metadata. |
| recursive | query | string | No | If true, returns the tree recursively. |
| limit | query | integer | No | 1.000 by default, 100 by default for expand=true |
| cursor | query | string | No |  |

**Responses:**

- **200**: List of entries in the repository tree

### GET /api/spaces/{namespace}/{repo}/notebook/{rev}/{path}

**Get notebook URL**

Get a jupyter notebook URL for the requested file

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |

**Responses:**

- **200**: Response containing the url of the notebook

### GET /api/spaces/{namespace}/{repo}/scan

**Get security status**

Get the security status of a repo

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The security status of the repo

### GET /api/spaces/{namespace}/{repo}/jwt

**Generate JWT**

Generate a JWT token for accessing a repository. Supports optional write access for spaces in dev mode, custom expiration, and encryption.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| write | query | string | No |  |
| expiration | query | string | No |  |
| encrypted | query | string | No |  |
| inference_api | query | string | No |  |
| include_pro_status | query | string | No |  |
| billing_details | query | string | No |  |

**Responses:**

- **200**: The JWT token and related information

### GET /api/trending

**Get trending**

Get the trending repositories

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| type | query | all \| dataset \| model \| space | No |  |
| limit | query | integer | No |  |

**Responses:**

- **200**: Trending repos

### GET /api/spaces/hardware

**List space hardware**

Get available space hardware

**Responses:**

- **200**: Available space hardware (public only)

### POST /api/spaces/{namespace}/{repo}/secrets

**Upsert secret**

Upsert Spaces's secret

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "pattern": "^[a-zA-Z][_a-zA-Z0-9]*$"
    },
    "description": {
      "type": "string"
    },
    "value": {
      "default": "",
      "type": "string"
    }
  },
  "required": [
    "key"
  ]
}
```

### DELETE /api/spaces/{namespace}/{repo}/secrets

**Delete secret**

Delete Spaces's secret

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "key": {
      "type": "string"
    }
  },
  "required": [
    "key"
  ]
}
```

### GET /api/spaces/{namespace}/{repo}/secrets

**List secrets**

List a Space's secret keys. Values are never returned.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: Secret keys indexed by name.

### POST /api/spaces/{namespace}/{repo}/variables

**Upsert variable**

Upsert Spaces's variable

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "pattern": "^[a-zA-Z][_a-zA-Z0-9]*$"
    },
    "description": {
      "type": "string"
    },
    "value": {
      "default": "",
      "type": "string"
    }
  },
  "required": [
    "key"
  ]
}
```

### DELETE /api/spaces/{namespace}/{repo}/variables

**Delete variable**

Delete Spaces's variable

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "key": {
      "type": "string"
    }
  },
  "required": [
    "key"
  ]
}
```

### GET /api/spaces/{namespace}/{repo}/variables

**List variables**

List a Space's variables with their values.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: Variables indexed by name

### GET /spaces/{namespace}/{repo}/resolve/{rev}/{path}

**Resolve a file**

This endpoint requires to follow redirection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| Range | header | string | No | The range in bytes of the file to download |
| Accept | header | string | No | Returns json information about the XET file info - if the file is a xet file |

**Responses:**

- **200**: The XET file info only available if the accept header is set to application/vnd.xet-fileinfo+json
- **302**: Redirection to file
- **304**: Not modified
- **307**: Redirection to Xet endpoint

### GET /api/resolve-cache/spaces/{namespace}/{repo}/{rev}/{path}

**Resolve a file**

This endpoint requires to follow redirection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| rev | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| Range | header | string | No | The range in bytes of the file to download |
| Accept | header | string | No | Returns json information about the XET file info - if the file is a xet file |

**Responses:**

- **200**: The XET file info only available if the accept header is set to application/vnd.xet-fileinfo+json
- **302**: Redirection to file
- **304**: Not modified
- **307**: Redirection to Xet endpoint

### PUT /api/spaces/{namespace}/{repo}/volumes

**Set Space volumes**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "volumes": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "enum": [
              "bucket",
              "model",
              "dataset",
              "space"
            ]
          },
          "source": {
            "description": "Source identifier, e.g. 'username/my-bucket' or 'username/my-model'",
            "type": "string"
          },
          "mountPath": {
            "description": "Mount path inside the container, e.g. '/data'",
            "type": "string",
            "pattern": "^\\/.*"
          },
          "revision": {
            "description": "Git revision (only for repos, defaults to 'main')",
            "type": "string"
          },
          "readOnly": {
            "description": "Read-only mount (true for repos, false default for buckets)",
            "type": "boolean"
          },
          "path": {
            "description": "Subfolder prefix inside the bucket/repo to mount, e.g. 'path/to/dir'",
            "type": "string"
          }
        },
        "required": [
          "type",
          "source",
          "mountPath"
        ]
      }
    }
  },
  "required": [
    "volumes"
  ]
}
```

### DELETE /api/spaces/{namespace}/{repo}/volumes

**Delete Space volumes**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

### GET /api/spaces/{namespace}/{repo}/logs/{logType}

**Stream logs**

Get logs for a specific Space in a streaming fashion, with SSE protocol

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| logType | path | string | Yes |  |
| tail | query | integer | No | Maximum number of lines to return from the logs. |

### GET /api/spaces/{namespace}/{repo}/events

**Stream events**

Get status updates for a specific Space in a streaming fashion, with SSE protocol

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| session_uuid | query | string | No |  |

### GET /api/spaces/{namespace}/{repo}/metrics

**Stream metrics**

Get live metrics for a specific Space in a streaming fashion, with SSE protocol, such as current Zero-GPU usage

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

## Repository Search

The following endpoints help get information about models, datasets, and Spaces stored on the Hub.

### GET /api/quicksearch

**Quick search**

Quick search for models, datasets, spaces, orgs, users, papers, collections, and buckets

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| q | query | string | No |  |
| limit | query | string | No |  |
| lang | query | string | No |  |
| library | query | string | No |  |
| type | query | string | No |  |
| orgsFilter | query | string | No |  |
| reposFilter | query | string | No |  |
| pipelines | query | string | No | Comma-separated or array of pipeline types |
| exclude | query | array | No | Array of excluded resources: spaces/repo, models/repo, datasets/repo, papers/paperId, collections/collectionId, users/username, orgs/orgName, buckets/bucketName |
| namespace | query | string | No | Namespace to filter by |
| includeInvitees | query | string | No |  |
| repoName | query | string | No |  |
| repoType | query | string | No |  |
| discussionId | query | string | No |  |
| discussionCollectionName | query | string | No |  |
| spacesTags | query | array | No |  |

**Responses:**

- **200**: The quick search results

### POST /api/quicksearch

**Quick search**

Quick search for models, datasets, spaces, orgs, users, papers, collections, and buckets

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| q | query | string | No |  |
| limit | query | string | No |  |
| lang | query | string | No |  |
| library | query | string | No |  |
| type | query | string | No |  |
| orgsFilter | query | string | No |  |
| reposFilter | query | string | No |  |
| pipelines | query | string | No | Comma-separated or array of pipeline types |
| exclude | query | array | No | Array of excluded resources: spaces/repo, models/repo, datasets/repo, papers/paperId, collections/collectionId, users/username, orgs/orgName, buckets/bucketName |
| namespace | query | string | No | Namespace to filter by |
| includeInvitees | query | string | No |  |
| repoName | query | string | No |  |
| repoType | query | string | No |  |
| discussionId | query | string | No |  |
| discussionCollectionName | query | string | No |  |
| spacesTags | query | array | No |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "q": {
      "default": "",
      "type": "string"
    },
    "limit": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 20
        },
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 20
        }
      ]
    },
    "lang": {
      "anyOf": [
        {
          "enum": [
            "aa",
            "ab",
            "ae",
            "af",
            "ak",
            "am",
            "an",
            "ar",
            "as",
            "av",
            "ay",
            "az",
            "ba",
            "be",
            "bg",
            "bh",
            "bi",
            "bm",
            "bn",
            "bo",
            "br",
            "bs",
            "ca",
            "ce",
            "ch",
            "co",
            "cr",
            "cs",
            "cu",
            "cv",
            "cy",
            "da",
            "de",
            "dv",
            "dz",
            "ee",
            "el",
            "en",
            "eo",
            "es",
            "et",
            "eu",
            "fa",
            "ff",
            "fi",
            "fj",
            "fo",
            "fr",
            "fy",
            "ga",
            "gd",
            "gl",
            "gn",
            "gu",
            "gv",
            "ha",
            "he",
            "hi",
            "ho",
            "hr",
            "ht",
            "hu",
            "hy",
            "hz",
            "ia",
            "id",
            "ie",
            "ig",
            "ii",
            "ik",
            "io",
            "is",
            "it",
            "iu",
            "ja",
            "jv",
            "ka",
            "kg",
            "ki",
            "kj",
            "kk",
            "kl",
            "km",
            "kn",
            "ko",
            "kr",
            "ks",
            "ku",
            "kv",
            "kw",
            "ky",
            "la",
            "lb",
            "lg",
            "li",
            "ln",
            "lo",
            "lt",
            "lu",
            "lv",
            "mg",
            "mh",
            "mi",
            "mk",
            "ml",
            "mn",
            "mr",
            "ms",
            "mt",
            "my",
            "na",
            "nb",
            "nd",
            "ne",
            "ng",
            "nl",
            "nn",
            "no",
            "nr",
            "nv",
            "ny",
            "oc",
            "oj",
            "om",
            "or",
            "os",
            "pa",
            "pi",
            "pl",
            "ps",
            "pt",
            "qu",
            "rm",
            "rn",
            "ro",
            "ru",
            "rw",
            "sa",
            "sc",
            "sd",
            "se",
            "sg",
            "si",
            "sk",
            "sl",
            "sm",
            "sn",
            "so",
            "sq",
            "sr",
            "ss",
            "st",
            "su",
            "sv",
            "sw",
            "ta",
            "te",
            "tg",
            "th",
            "ti",
            "tk",
            "tl",
            "tn",
            "to",
            "tr",
            "ts",
            "tt",
            "tw",
            "ty",
            "ug",
            "uk",
            "ur",
            "uz",
            "ve",
            "vi",
            "vo",
            "wa",
            "wo",
            "xh",
            "yi",
            "yo",
            "za",
            "zh",
            "zu"
          ]
        },
        {
          "type": "string"
        }
      ]
    },
    "library": {
      "anyOf": [
        {
          "enum": [
            "acestep",
            "adapter-transformers",
            "allennlp",
            "anemoi",
            "araclip",
            "aviation-ner",
            "asteroid",
            "audiocraft",
            "audioseal",
            "bagel-mot",
            "bboxmaskpose",
            "ben2",
            "bertopic",
            "big_vision",
            "bionemo",
            "birder",
            "birefnet",
            "bm25s",
            "boltzgen",
            "cancertathomev2",
            "cartesia_pytorch",
            "cartesia_mlx",
            "champ",
            "chatterbox",
            "chaossim",
            "chat_tts",
            "chronos-forecasting",
            "clara",
            "clipscope",
            "cloud-agents",
            "collectorvision",
            "colipri",
            "cosyvoice",
            "cotracker",
            "colpali",
            "comet",
            "cosmos",
            "cxr-foundation",
            "deepforest",
            "depth-anything-v2",
            "depth-pro",
            "derm-foundation",
            "describe-anything",
            "dia-tts",
            "dia2",
            "diff-interpretation-tuning",
            "diffree",
            "diffusers",
            "diffusionkit",
            "docking-at-home",
            "doctr",
            "edsnlp",
            "elm",
            "encoderfile",
            "espnet",
            "eupe",
            "fairseq",
            "fastai",
            "fastprint",
            "fasttext",
            "fixer",
            "flair",
            "fme",
            "gemma.cpp",
            "geometry-crafter",
            "gliner",
            "gliner2",
            "glm-tts",
            "glyph-byt5",
            "granite-library",
            "grok",
            "habibi-tts",
            "hallo",
            "hermes",
            "holomotion",
            "hezar",
            "htrflow",
            "hunyuan-dit",
            "hunyuan3d-2",
            "hunyuanworld-voyager",
            "hy-worldplay",
            "hy-world-2",
            "image-matching-models",
            "imstoucan",
            "index-tts",
            "infinitetalk",
            "infinite-you",
            "intellifold",
            "ising-decoding",
            "keras",
            "tf-keras",
            "keras-hub",
            "kernels",
            "kimi-audio",
            "kittentts",
            "kronos",
            "k2",
            "lyra-2.0",
            "lagernvs",
            "lightning-ir",
            "litert",
            "litert-lm",
            "lerobot",
            "lightglue",
            "liveportrait",
            "llama-cpp-python",
            "mini-omni2",
            "mindspore",
            "magi-1",
            "magenta-realtime",
            "mamba-ssm",
            "manas-1",
            "mars5-tts",
            "matanyone",
            "mesh-anything",
            "merlin",
            "medvae",
            "mitie",
            "ml-agents",
            "ml-sharp",
            "mlx",
            "mlx-image",
            "mlc-llm",
            "model2vec",
            "moshi",
            "mtvcraft",
            "multimolecule",
            "nemo",
            "nv-medtech",
            "open-oasis",
            "open_clip",
            "openpeerllm",
            "open-sora",
            "outetts",
            "paddlenlp",
            "PaddleOCR",
            "peft",
            "perception-encoder",
            "phantom-wan",
            "pocket-tts",
            "pruna-ai",
            "pxia",
            "pyannote-audio",
            "py-feat",
            "pythae",
            "quantumpeer",
            "qwen3_tts",
            "recurrentgemma",
            "relik",
            "refiners",
            "renderformer",
            "reverb",
            "rkllm",
            "robo-orchard-lab",
            "saelens",
            "sam2",
            "sam-3d-body",
            "sam-3d-objects",
            "same",
            "sample-factory",
            "sap-rpt-1-oss",
            "sapiens",
            "sapiens2",
            "seedvr",
            "self-forcing",
            "sentence-transformers",
            "setfit",
            "sklearn",
            "spacy",
            "span-marker",
            "speechbrain",
            "ssr-speech",
            "stable-audio-3",
            "stable-audio-tools",
            "monkeyocr",
            "diffusion-single-file",
            "seed-story",
            "skala",
            "soloaudio",
            "songbloom",
            "stable-baselines3",
            "stanza",
            "supertonic",
            "swarmformer",
            "synthefy-migas",
            "f5-tts",
            "genmo",
            "tencent-song-generation",
            "tensorflowtts",
            "tensorrt",
            "tabpfn",
            "terratorch",
            "tic-clip",
            "timesfm",
            "timm",
            "tirex",
            "torchgeo",
            "transformers",
            "transformers.js",
            "trellis",
            "trellis2",
            "ultralytics",
            "univa",
            "uni-3dar",
            "unity-sentis",
            "sana",
            "videoprism",
            "vfi-mamba",
            "vismatch",
            "lvface",
            "voicecraft",
            "voxcpm",
            "vui",
            "vibevoice",
            "videox_fun",
            "wan2.2",
            "wham",
            "whisperkit",
            "yolov10",
            "yolov26",
            "zonos",
            "3dtopia-xl"
          ]
        },
        {
          "type": "string"
        }
      ]
    },
    "type": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "enum": [
              "model",
              "dataset",
              "space",
              "org",
              "user",
              "paper",
              "collection",
              "bucket"
            ]
          }
        },
        {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "orgsFilter": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "enum": [
              "own",
              "unwatched"
            ]
          }
        },
        {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "reposFilter": {
      "anyOf": [
        {
          "type": "array",
          "items": {
            "enum": [
              "skip_disabled",
              "skip_gated",
              "own",
              "own_orgs",
              "granted_access"
            ]
          }
        },
        {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      ]
    },
    "pipelines": {
      "description": "Comma-separated or array of pipeline types",
      "anyOf": [
        {
          "type": "array",
          "items": {
            "enum": [
              "text-classification",
              "token-classification",
              "table-question-answering",
              "question-answering",
              "zero-shot-classification",
              "translation",
              "summarization",
              "feature-extraction",
              "text-generation",
              "fill-mask",
              "sentence-similarity",
              "text-to-speech",
              "text-to-audio",
              "automatic-speech-recognition",
              "audio-to-audio",
              "audio-classification",
              "audio-text-to-text",
              "voice-activity-detection",
              "depth-estimation",
              "image-classification",
              "object-detection",
              "image-segmentation",
              "text-to-image",
              "image-to-text",
              "image-to-image",
              "image-to-video",
              "unconditional-image-generation",
              "video-classification",
              "reinforcement-learning",
              "robotics",
              "tabular-classification",
              "tabular-regression",
              "tabular-to-text",
              "table-to-text",
              "multiple-choice",
              "text-ranking",
              "text-retrieval",
              "time-series-forecasting",
              "text-to-video",
              "image-text-to-text",
              "image-text-to-image",
              "image-text-to-video",
              "visual-question-answering",
              "document-question-answering",
              "zero-shot-image-classification",
              "graph-ml",
              "mask-generation",
              "zero-shot-object-detection",
              "text-to-3d",
              "image-to-3d",
              "image-feature-extraction",
              "video-text-to-text",
              "keypoint-detection",
              "visual-document-retrieval",
              "any-to-any",
              "video-to-video",
              "other"
            ]
          }
        },
        {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          ]
        }
      ]
    },
    "exclude": {
      "description": "Array of excluded resources: spaces/repo, models/repo, datasets/repo, papers/paperId, collections/collectionId, users/username, orgs/orgName, buckets/bucketName",
      "default": [],
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^(spaces|models|datasets|papers|collections|users|orgs|buckets)\\/.*"
      }
    },
    "namespace": {
      "description": "Namespace to filter by",
      "type": "string"
    },
    "includeInvitees": {
      "default": false,
      "anyOf": [
        {
          "type": "boolean"
        },
        {}
      ]
    },
    "repoName": {
      "type": "string"
    },
    "repoType": {
      "anyOf": [
        {
          "enum": [
            "dataset",
            "model",
            "space",
            "bucket",
            "kernel"
          ]
        },
        {
          "type": "string"
        }
      ]
    },
    "discussionId": {
      "type": "string",
      "minLength": 24,
      "maxLength": 24,
      "pattern": "^[0-9a-fA-F]{24}$"
    },
    "discussionCollectionName": {
      "type": "string"
    },
    "spacesTags": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "exclude",
    "bucketNamespace"
  ]
}
```

**Responses:**

- **200**: The quick search results

## Repositories

The following endpoints manage repository settings like creating and deleting a repository.

### POST /api/{repoType}/{namespace}/{repo}/duplicate

**Duplicate a repository**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| repoType | path | string | Yes |  |
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "repository": {
      "type": "string"
    },
    "private": {
      "type": "boolean"
    },
    "visibility": {
      "enum": [
        "private",
        "public",
        "protected"
      ]
    },
    "resourceGroupId": {
      "anyOf": [
        {
          "anyOf": [
            {
              "type": "string",
              "minLength": 24,
              "maxLength": 24,
              "pattern": "^[0-9a-fA-F]{24}$"
            },
            {
              "type": "null"
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "hardware": {
      "default": "",
      "enum": [
        "cpu-basic",
        "cpu-upgrade",
        "cpu-performance",
        "cpu-xl",
        "sprx8",
        "zero-a10g",
        "t4-small",
        "t4-medium",
        "l4x1",
        "l4x4",
        "l40sx1",
        "l40sx4",
        "l40sx8",
        "a10g-small",
        "a10g-large",
        "a10g-largex2",
        "a10g-largex4",
        "a100-large",
        "a100x4",
        "a100x8",
        "h200",
        "h200x2",
        "h200x4",
        "h200x8",
        "rtx-pro-6000",
        "rtx-pro-6000x2",
        "rtx-pro-6000x4",
        "rtx-pro-6000x8",
        "inf2x6",
        ""
      ]
    },
    "sleepTimeSeconds": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "const": -1
        }
      ]
    },
    "secrets": {
      "default": [],
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "pattern": "^[a-zA-Z][_a-zA-Z0-9]*$"
          },
          "description": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "required": [
          "key",
          "value"
        ]
      }
    },
    "variables": {
      "default": [],
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "pattern": "^[a-zA-Z][_a-zA-Z0-9]*$"
          },
          "description": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "required": [
          "key",
          "value"
        ]
      }
    },
    "volumes": {
      "description": "HuggingFace Buckets or Repos to mount as volumes in the duplicated Space.",
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "enum": [
              "bucket",
              "model",
              "dataset",
              "space"
            ]
          },
          "source": {
            "description": "Source identifier, e.g. 'username/my-bucket' or 'username/my-model'",
            "type": "string"
          },
          "mountPath": {
            "description": "Mount path inside the container, e.g. '/data'",
            "type": "string",
            "pattern": "^\\/.*"
          },
          "revision": {
            "description": "Git revision (only for repos, defaults to 'main')",
            "type": "string"
          },
          "readOnly": {
            "description": "Read-only mount (true for repos, false default for buckets)",
            "type": "boolean"
          },
          "path": {
            "description": "Subfolder prefix inside the bucket/repo to mount, e.g. 'path/to/dir'",
            "type": "string"
          }
        },
        "required": [
          "type",
          "source",
          "mountPath"
        ]
      }
    }
  },
  "required": [
    "repository"
  ]
}
```

**Responses:**

- **200**: Repository created, url is given

### POST /api/repos/create

**Create a new repository**

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "allOf": [
    {
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        },
        "organization": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        },
        "region": {
          "description": "The region where the repository is hosted.",
          "enum": [
            "us",
            "eu"
          ]
        },
        "license": {
          "description": "The license of the repository. You can select 'Other' if your license is not in the list",
          "enum": [
            "apache-2.0",
            "mit",
            "openrail",
            "bigscience-openrail-m",
            "creativeml-openrail-m",
            "bigscience-bloom-rail-1.0",
            "bigcode-openrail-m",
            "afl-3.0",
            "artistic-2.0",
            "bsl-1.0",
            "bsd",
            "bsd-2-clause",
            "bsd-3-clause",
            "bsd-3-clause-clear",
            "c-uda",
            "cc",
            "cc0-1.0",
            "cc-by-2.0",
            "cc-by-2.5",
            "cc-by-3.0",
            "cc-by-4.0",
            "cc-by-sa-3.0",
            "cc-by-sa-4.0",
            "cc-by-nc-2.0",
            "cc-by-nc-3.0",
            "cc-by-nc-4.0",
            "cc-by-nd-4.0",
            "cc-by-nc-nd-3.0",
            "cc-by-nc-nd-4.0",
            "cc-by-nc-sa-2.0",
            "cc-by-nc-sa-3.0",
            "cc-by-nc-sa-4.0",
            "cdla-sharing-1.0",
            "cdla-permissive-1.0",
            "cdla-permissive-2.0",
            "wtfpl",
            "ecl-2.0",
            "epl-1.0",
            "epl-2.0",
            "etalab-2.0",
            "eupl-1.1",
            "eupl-1.2",
            "agpl-3.0",
            "gfdl",
            "gpl",
            "gpl-2.0",
            "gpl-3.0",
            "lgpl",
            "lgpl-2.1",
            "lgpl-3.0",
            "isc",
            "h-research",
            "intel-research",
            "lppl-1.3c",
            "ms-pl",
            "apple-ascl",
            "apple-amlr",
            "mpl-2.0",
            "odc-by",
            "odbl",
            "openmdw-1.0",
            "openrail++",
            "osl-3.0",
            "postgresql",
            "ofl-1.1",
            "ncsa",
            "unlicense",
            "zlib",
            "pddl",
            "lgpl-lr",
            "deepfloyd-if-license",
            "fair-noncommercial-research-license",
            "llama2",
            "llama3",
            "llama3.1",
            "llama3.2",
            "llama3.3",
            "llama4",
            "grok2-community",
            "gemma",
            "unknown",
            "other"
          ]
        },
        "license_name": {
          "type": "string",
          "pattern": "^[a-z0-9-.]+$"
        },
        "license_link": {
          "anyOf": [
            {
              "const": "LICENSE"
            },
            {
              "const": "LICENSE.md"
            },
            {
              "type": "string",
              "format": "uri"
            }
          ]
        },
        "private": {
          "description": "Repository visibility. Defaults to public. Cannot be specified along with visibility.",
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ]
        },
        "visibility": {
          "description": "Repository visibility. `protected` is only supported for Spaces. Cannot be specified along with private.",
          "enum": [
            "private",
            "public",
            "protected"
          ]
        },
        "resourceGroupId": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 24,
              "maxLength": 24,
              "pattern": "^[0-9a-fA-F]{24}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "files": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "content": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "encoding": {
                "enum": [
                  "utf-8",
                  "base64"
                ]
              }
            },
            "required": [
              "content",
              "path"
            ]
          }
        }
      },
      "required": [
        "name"
      ]
    },
    {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "type": {
              "const": "dataset"
            }
          },
          "required": [
            "type"
          ]
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "default": "model",
              "const": "model"
            }
          }
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "const": "kernel"
            }
          },
          "required": [
            "type"
          ]
        },
        {
          "type": "object",
          "properties": {
            "type": {
              "const": "space"
            },
            "template": {
              "type": "string"
            },
            "short_description": {
              "type": "string",
              "maxLength": 60
            },
            "hardware": {
              "description": "The hardware flavor of the space. If you select 'zero-a10g' or 'zerogpu', the SDK must be Gradio.",
              "enum": [
                "cpu-basic",
                "cpu-upgrade",
                "cpu-performance",
                "cpu-xl",
                "sprx8",
                "zero-a10g",
                "t4-small",
                "t4-medium",
                "l4x1",
                "l4x4",
                "l40sx1",
                "l40sx4",
                "l40sx8",
                "a10g-small",
                "a10g-large",
                "a10g-largex2",
                "a10g-largex4",
                "a100-large",
                "a100x4",
                "a100x8",
                "h200",
                "h200x2",
                "h200x4",
                "h200x8",
                "rtx-pro-6000",
                "rtx-pro-6000x2",
                "rtx-pro-6000x4",
                "rtx-pro-6000x8",
                "inf2x6",
                "zerogpu"
              ]
            },
            "secrets": {
              "default": [],
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "string",
                    "pattern": "^[a-zA-Z][_a-zA-Z0-9]*$"
                  },
                  "description": {
                    "type": "string"
                  },
                  "value": {
                    "type": "string"
                  }
                },
                "required": [
                  "key",
                  "value"
                ]
              }
            },
            "variables": {
              "default": [],
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "key": {
                    "type": "string",
                    "pattern": "^[a-zA-Z][_a-zA-Z0-9]*$"
                  },
                  "description": {
                    "type": "string"
                  },
                  "value": {
                    "type": "string"
                  }
                },
                "required": [
                  "key",
                  "value"
                ]
              }
            },
            "sleepTimeSeconds": {
              "anyOf": [
                {
                  "type": "integer",
                  "exclusiveMinimum": 0,
                  "maximum": 9007199254740991
                },
                {
                  "const": -1
                }
              ]
            },
            "volumes": {
              "description": "HuggingFace Buckets or Repos to mount as volumes in the Space container.",
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "type": {
                    "enum": [
                      "bucket",
                      "model",
                      "dataset",
                      "space"
                    ]
                  },
                  "source": {
                    "description": "Source identifier, e.g. 'username/my-bucket' or 'username/my-model'",
                    "type": "string"
                  },
                  "mountPath": {
                    "description": "Mount path inside the container, e.g. '/data'",
                    "type": "string",
                    "pattern": "^\\/.*"
                  },
                  "revision": {
                    "description": "Git revision (only for repos, defaults to 'main')",
                    "type": "string"
                  },
                  "readOnly": {
                    "description": "Read-only mount (true for repos, false default for buckets)",
                    "type": "boolean"
                  },
                  "path": {
                    "description": "Subfolder prefix inside the bucket/repo to mount, e.g. 'path/to/dir'",
                    "type": "string"
                  }
                },
                "required": [
                  "type",
                  "source",
                  "mountPath"
                ]
              }
            },
            "sdk": {
              "enum": [
                "gradio",
                "docker",
                "static"
              ]
            },
            "sdkVersion": {
              "anyOf": [
                {
                  "type": "string"
                },
                {
                  "type": "null"
                }
              ]
            },
            "devModeEnabled": {
              "type": "boolean"
            }
          },
          "required": [
            "type",
            "sdk"
          ]
        }
      ]
    }
  ]
}
```

**Responses:**

- **200**: Repository created, url is given
- **409**: Repository already exists, url is given

### POST /api/repos/move

**Move repo**

Move or rename a repo

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "fromRepo": {
      "examples": [
        "black-forest-labs/FLUX.1-dev"
      ],
      "type": "string"
    },
    "toRepo": {
      "type": "string"
    },
    "type": {
      "default": "model",
      "enum": [
        "dataset",
        "model",
        "space",
        "bucket",
        "kernel"
      ]
    }
  },
  "required": [
    "fromRepo",
    "toRepo"
  ]
}
```

## Users

User accounts are the base authoring entity on the Hub

### GET /api/settings/mcp

**Get MCP tools**

Get the MCP tools for the current user

**Responses:**

- **200**: The MCP tools for the current user

### GET /api/settings/repositories

**List user repositories with storage info**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| search | query | string | No | Filter repositories by name (case-insensitive substring match) |
| type | query | dataset \| model \| space \| bucket \| kernel | No | Filter by repository type |
| limit | query | integer | No | Max number of repositories to return |
| sort | query | storage \| updatedAt | No | Sort field (default: storage) |
| direction | query | asc \| desc | No | Sort direction (default: desc) |

**Responses:**

- **200**: Repositories with storage usage

### GET /api/settings/billing/usage

**Get user usage**

Get user usage for a given period

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| periodId | query | string | No |  |

**Responses:**

- **200**: Usage and period information

### GET /api/settings/billing/usage-v2

**Get user usage**

Get user usage for a given period

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| startDate | query | integer | Yes |  |
| endDate | query | integer | Yes |  |

### GET /api/settings/billing/usage/jobs

**Get jobs usage**

Get user Jobs usage for current subscription period

**Responses:**

- **200**: Jobs usage information

### GET /api/settings/billing/usage/live

**Stream usage**

Get live usage for user

### GET /api/users/{username}/billing/usage/live

**Stream usage**

Get live usage for user

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| username | path | string | Yes |  |

### GET /api/users/{username}/overview

**User overview**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| username | path | string | Yes |  |

**Responses:**

- **200**: User overview data including their organizations, stats, and creation date

### GET /api/users/{username}/socials

**Get social handles**

Get a user's social media handles

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| username | path | string | Yes |  |

**Responses:**

- **200**: The user's social media handles. Only includes handles that the user has provided.

### GET /api/users/{username}/avatar

**Retrieve user avatar**

This endpoint returns a JSON with the avatar URL for the user.

If called with the `Sec-Fetch-Dest: image` header, it instead redirects to the avatar URL

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| username | path | string | Yes |  |
| redirect | query | string | No | Redirect to the avatar url instead of returning it |

**Responses:**

- **200**: Avatar URL

### GET /api/users/{username}/likes

**List user likes**

List public repos liked by a user

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| username | path | string | Yes |  |
| limit | query | integer | No | Max number of likes to return |
| cursor | query | string | No | Cursor for pagination. Always check to see if more results, a page can be empty or not filled. |

**Responses:**

- **200**: Likes on public repositories

### GET /api/avatars/{namespace}

**Get avatar**

Display the avatar for any user or organization. This endpoint redirects to the avatar URL for either a user or an organization

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |

## Organizations

The following endpoints let you interact with Hub Organizations and their members.

### POST /api/organizations/{name}/settings/tokens/revoke

**Revoke a member's access token from the organization**

An org admin can revoke a token's access to the org. The token itself isn't deleted, it still works outside the org. Requires the raw token value. Enterprise only.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "token": {
      "type": "string",
      "pattern": "^hf_.*"
    }
  },
  "required": [
    "token"
  ]
}
```

### GET /api/organizations/{name}/settings/repositories

**List organization repositories with storage info**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| search | query | string | No | Filter repositories by name (case-insensitive substring match) |
| type | query | dataset \| model \| space \| bucket \| kernel | No | Filter by repository type |
| limit | query | integer | No | Max number of repositories to return |
| sort | query | storage \| updatedAt | No | Sort field (default: storage) |
| direction | query | asc \| desc | No | Sort direction (default: desc) |

**Responses:**

- **200**: Organization repositories with storage usage

### GET /api/organizations/{name}/audit-log/export

**Export the audit log**

Export the audit log events in JSON format for a Team or Enterprise organization. The export is limited to the last 100,000 events.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| q | query | string | No |  |

**Responses:**

- **200**: Array of audit log events

### GET /api/organizations/{name}/settings/network-security

**Get network security settings**

Get the network security settings for an organization.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Responses:**

- **200**: Network security settings

### PATCH /api/organizations/{name}/settings/network-security

**Update network security settings**

Update the network security settings for an organization.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "enforceAuth": {
      "type": "boolean"
    },
    "enforceIpRestriction": {
      "type": "boolean"
    },
    "highRateLimits": {
      "type": "boolean"
    },
    "ipRanges": {
      "minItems": 1,
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "string",
            "format": "cidrv4",
            "pattern": "^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\\/([0-9]|[1-2][0-9]|3[0-2])$"
          },
          {
            "type": "string",
            "format": "cidrv6",
            "pattern": "^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$"
          }
        ]
      }
    },
    "blockedContents": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "resource": {
            "anyOf": [
              {
                "enum": [
                  "dataset",
                  "model",
                  "space",
                  "bucket",
                  "kernel"
                ]
              },
              {
                "const": "*"
              }
            ]
          },
          "scope": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "resource",
          "scope"
        ]
      }
    },
    "allowedContents": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "resource": {
            "anyOf": [
              {
                "enum": [
                  "dataset",
                  "model",
                  "space",
                  "bucket",
                  "kernel"
                ]
              },
              {
                "const": "*"
              }
            ]
          },
          "scope": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "resource",
          "scope"
        ]
      }
    }
  }
}
```

**Responses:**

- **200**: Updated network security settings

### GET /api/organizations/{name}/avatar

**Get avatar**

Retrieve organization avatar. This endpoint returns a JSON with the avatar URL for the organization.

If called with the `Sec-Fetch-Dest: image` header, it instead redirects to the avatar URL

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| redirect | query | string | No | Redirect to the avatar url instead of returning it |

**Responses:**

- **200**: Avatar URL

### GET /api/organizations/{name}/members

**Get organization members**

Get a list of members for the organization with optional search and pagination.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| search | query | string | No |  |
| email | query | string | No |  |
| cursor | query | string | No |  |
| limit | query | integer | No |  |

**Responses:**

- **200**: Array of organization members

### PUT /api/organizations/{name}/members/{username}/role

**Change member role**

Change the role of a member in the organization. Need a paid plan.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| username | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "role": {
      "anyOf": [
        {
          "enum": [
            "admin",
            "write",
            "contributor",
            "read",
            "no_access"
          ]
        },
        {
          "description": "Custom role name",
          "type": "string"
        }
      ]
    },
    "resourceGroups": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 24,
            "maxLength": 24,
            "pattern": "^[0-9a-fA-F]{24}$"
          },
          "role": {
            "anyOf": [
              {
                "enum": [
                  "admin",
                  "write",
                  "contributor",
                  "read",
                  "no_access"
                ]
              },
              {
                "description": "Custom role name",
                "type": "string"
              }
            ]
          }
        },
        "required": [
          "id",
          "role"
        ]
      }
    }
  },
  "required": [
    "role"
  ]
}
```

### GET /api/organizations/{name}/billing/usage

**Get org usage**

Get org usage for a given period

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| periodId | query | string | No |  |

**Responses:**

- **200**: Usage and period information

### GET /api/organizations/{name}/billing/usage-v2

**Get org usage**

Get org usage for a given period

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| startDate | query | integer | Yes |  |
| endDate | query | integer | Yes |  |

### GET /api/organizations/{name}/billing/usage-by-resource-group

**Get org usage by resource group**

Get org usage breakdown per resource group for a given period (max 3 months)

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| startDate | query | string | Yes |  |
| endDate | query | string | Yes |  |

**Responses:**

- **200**: Org usage breakdown per resource group

### GET /api/organizations/{name}/billing/usage/live

**Stream usage**

Get live usage for org

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

### GET /api/organizations/{name}/socials

**Get social handles**

Get an organization's social media handles

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Responses:**

- **200**: The organization's social media handles. Only includes handles that the organization has provided.

### GET /api/avatars/{namespace}

**Get avatar**

Display the avatar for any user or organization. This endpoint redirects to the avatar URL for either a user or an organization

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |

## Jobs

The following endpoints manage jobs.

### POST /api/jobs/{namespace}/auth-check/{perms}

**Check access**

Check if the user has access to jobs in the namespace

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| perms | path | string | Yes |  |

**Responses:**

- **200**: The user has access to jobs in the namespace

### POST /api/jobs/{namespace}/{jobId}/auth-check/{perms}

**Check access**

Check if the user has access to jobs in the namespace

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |
| perms | path | string | Yes |  |

**Responses:**

- **200**: The user has access to jobs in the namespace

### GET /api/jobs/hardware

**Get job hardware**

Get available job hardware

**Responses:**

- **200**: Available job hardware (public only)

### GET /api/jobs/{namespace}

**List jobs**

List of jobs for an entity

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| label | query | string | No | Filter jobs by label. Format: 'key=value' (e.g., 'environment=production'). |

**Responses:**

- **200**: The list of jobs

### POST /api/jobs/{namespace}

**Start a job**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "spaceId": {
      "type": "string"
    },
    "dockerImage": {
      "type": "string"
    },
    "arguments": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "command": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "environment": {
      "default": {},
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[a-zA-Z][_a-zA-Z0-9]+$"
      },
      "additionalProperties": {
        "type": "string"
      }
    },
    "secrets": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[a-zA-Z][_a-zA-Z0-9]*$"
      },
      "additionalProperties": {
        "type": "string"
      }
    },
    "flavor": {
      "enum": [
        "cpu-basic",
        "cpu-upgrade",
        "cpu-performance",
        "cpu-xl",
        "sprx8",
        "zero-a10g",
        "t4-small",
        "t4-medium",
        "l4x1",
        "l4x4",
        "l40sx1",
        "l40sx4",
        "l40sx8",
        "a10g-small",
        "a10g-large",
        "a10g-largex2",
        "a10g-largex4",
        "a100-large",
        "a100x4",
        "a100x8",
        "h200",
        "h200x2",
        "h200x4",
        "h200x8",
        "rtx-pro-6000",
        "rtx-pro-6000x2",
        "rtx-pro-6000x4",
        "rtx-pro-6000x8",
        "inf2x6"
      ]
    },
    "arch": {
      "enum": [
        "amd64",
        "arm64"
      ]
    },
    "timeoutSeconds": {
      "default": null,
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "attempts": {
      "description": "Max number of attempts to make. For example, if you set this to 3, the job will be retried up to 2 times if it fails.",
      "default": 1,
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "labels": {
      "description": "Labels for the job as key-value pairs. Both keys and values must be max 100 characters and contain only alphanumeric characters, dots, dashes, and underscores.",
      "type": "object",
      "propertyNames": {
        "type": "string",
        "maxLength": 100,
        "pattern": "^[a-zA-Z0-9._-]+$"
      },
      "additionalProperties": {
        "type": "string",
        "maxLength": 100,
        "pattern": "^[a-zA-Z0-9._-]*$"
      }
    },
    "volumes": {
      "description": "HuggingFace Buckets or Repos to mount as volumes in the job container.",
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "enum": [
              "bucket",
              "model",
              "dataset",
              "space"
            ]
          },
          "source": {
            "description": "Source identifier, e.g. 'username/my-bucket' or 'username/my-model'",
            "type": "string"
          },
          "mountPath": {
            "description": "Mount path inside the container, e.g. '/data'",
            "type": "string",
            "pattern": "^\\/.*"
          },
          "revision": {
            "description": "Git revision (only for repos, defaults to 'main')",
            "type": "string"
          },
          "readOnly": {
            "description": "Read-only mount (true for repos, false default for buckets)",
            "type": "boolean"
          },
          "path": {
            "description": "Subfolder prefix inside the bucket/repo to mount, e.g. 'path/to/dir'",
            "type": "string"
          }
        },
        "required": [
          "type",
          "source",
          "mountPath"
        ]
      }
    },
    "expose": {
      "description": "When `enabled`, expose every port the job's container listens on through the jobs proxy. Each port is reachable at `https://<job_id>--<port>.jobs.huggingface.tech`. Any port the container binds to is proxied automatically; you do not need to declare specific ports. Access always requires a HF token with read access to the job's namespace.",
      "type": "object",
      "properties": {
        "enabled": {
          "default": false,
          "type": "boolean"
        }
      }
    }
  },
  "required": [
    "flavor"
  ]
}
```

**Responses:**

- **200**: The job after it has been started

### GET /api/jobs/{namespace}/count

**Count jobs**

Count the number of jobs for an entity with optional status stage filter

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| stage | query | string | No |  |

**Responses:**

- **200**: The count of jobs matching the filter

### GET /api/jobs/{namespace}/{jobId}

**Get a job**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

**Responses:**

- **200**: The job

### GET /api/jobs/{namespace}/{jobId}/logs

**Stream job logs**

Stream the logs of a job, using SSE

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |
| tail | query | integer | No | Maximum number of lines to return from the logs. |

### GET /api/jobs/{namespace}/{jobId}/metrics

**Stream job metrics**

Stream the metrics of a job, using SSE

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

### GET /api/jobs/{namespace}/{jobId}/events

**Stream job events**

Stream the events of a job, using SSE

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

### POST /api/jobs/{namespace}/{jobId}/cancel

**Cancel a job**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

**Responses:**

- **200**: The job after it has been canceled

### POST /api/jobs/{namespace}/{jobId}/duplicate

**Duplicate a job**

Duplicate an existing job, re-using its spec

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

**Responses:**

- **200**: The new job after it has been duplicated

### PUT /api/jobs/{namespace}/{jobId}/labels

**Update job labels**

Replace user-provided labels on a job

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "labels": {
      "description": "The new labels to set on the job. Replaces all existing labels.",
      "type": "object",
      "propertyNames": {
        "type": "string",
        "maxLength": 100,
        "pattern": "^[a-zA-Z0-9._-]+$"
      },
      "additionalProperties": {
        "type": "string",
        "maxLength": 100,
        "pattern": "^[a-zA-Z0-9._-]*$"
      }
    }
  },
  "required": [
    "labels"
  ]
}
```

**Responses:**

- **200**: The job after labels have been updated

### POST /api/scheduled-jobs/{namespace}

**Create a scheduled job**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "jobSpec": {
      "type": "object",
      "properties": {
        "spaceId": {
          "type": "string"
        },
        "dockerImage": {
          "type": "string"
        },
        "arguments": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "command": {
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "environment": {
          "default": {},
          "type": "object",
          "propertyNames": {
            "type": "string",
            "pattern": "^[a-zA-Z][_a-zA-Z0-9]+$"
          },
          "additionalProperties": {
            "type": "string"
          }
        },
        "secrets": {
          "type": "object",
          "propertyNames": {
            "type": "string",
            "pattern": "^[a-zA-Z][_a-zA-Z0-9]*$"
          },
          "additionalProperties": {
            "type": "string"
          }
        },
        "flavor": {
          "enum": [
            "cpu-basic",
            "cpu-upgrade",
            "cpu-performance",
            "cpu-xl",
            "sprx8",
            "zero-a10g",
            "t4-small",
            "t4-medium",
            "l4x1",
            "l4x4",
            "l40sx1",
            "l40sx4",
            "l40sx8",
            "a10g-small",
            "a10g-large",
            "a10g-largex2",
            "a10g-largex4",
            "a100-large",
            "a100x4",
            "a100x8",
            "h200",
            "h200x2",
            "h200x4",
            "h200x8",
            "rtx-pro-6000",
            "rtx-pro-6000x2",
            "rtx-pro-6000x4",
            "rtx-pro-6000x8",
            "inf2x6"
          ]
        },
        "arch": {
          "enum": [
            "amd64",
            "arm64"
          ]
        },
        "timeoutSeconds": {
          "default": null,
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "attempts": {
          "description": "Max number of attempts to make. For example, if you set this to 3, the job will be retried up to 2 times if it fails.",
          "default": 1,
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "labels": {
          "description": "Labels for the job as key-value pairs. Both keys and values must be max 100 characters and contain only alphanumeric characters, dots, dashes, and underscores.",
          "type": "object",
          "propertyNames": {
            "type": "string",
            "maxLength": 100,
            "pattern": "^[a-zA-Z0-9._-]+$"
          },
          "additionalProperties": {
            "type": "string",
            "maxLength": 100,
            "pattern": "^[a-zA-Z0-9._-]*$"
          }
        },
        "volumes": {
          "description": "HuggingFace Buckets or Repos to mount as volumes in the job container.",
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "type": {
                "enum": [
                  "bucket",
                  "model",
                  "dataset",
                  "space"
                ]
              },
              "source": {
                "description": "Source identifier, e.g. 'username/my-bucket' or 'username/my-model'",
                "type": "string"
              },
              "mountPath": {
                "description": "Mount path inside the container, e.g. '/data'",
                "type": "string",
                "pattern": "^\\/.*"
              },
              "revision": {
                "description": "Git revision (only for repos, defaults to 'main')",
                "type": "string"
              },
              "readOnly": {
                "description": "Read-only mount (true for repos, false default for buckets)",
                "type": "boolean"
              },
              "path": {
                "description": "Subfolder prefix inside the bucket/repo to mount, e.g. 'path/to/dir'",
                "type": "string"
              }
            },
            "required": [
              "type",
              "source",
              "mountPath"
            ]
          }
        },
        "expose": {
          "description": "When `enabled`, expose every port the job's container listens on through the jobs proxy. Each port is reachable at `https://<job_id>--<port>.jobs.huggingface.tech`. Any port the container binds to is proxied automatically; you do not need to declare specific ports. Access always requires a HF token with read access to the job's namespace.",
          "type": "object",
          "properties": {
            "enabled": {
              "default": false,
              "type": "boolean"
            }
          }
        }
      },
      "required": [
        "flavor"
      ]
    },
    "schedule": {
      "description": "CRON schedule expression (e.g., '0 9 * * 1' for 9 AM every Monday).",
      "type": "string",
      "pattern": "^(?:(@(annually|yearly|monthly|weekly|daily|hourly))|((((\\d+,)+\\d+|((\\*|\\d+)(\\/|-)\\d+)|\\d+|\\*) ?){5,7}))$"
    },
    "suspend": {
      "description": "Whether the scheduled job is suspended (paused)",
      "default": false,
      "type": "boolean"
    },
    "concurrency": {
      "description": "Whether multiple instances of this job can run concurrently",
      "default": false,
      "type": "boolean"
    }
  },
  "required": [
    "jobSpec",
    "schedule"
  ]
}
```

**Responses:**

- **200**: The scheduled job data

### GET /api/scheduled-jobs/{namespace}

**List scheduled jobs**

List scheduled jobs for an entity

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| label | query | string | No | Filter scheduled jobs by label. Format: 'key=value' (e.g., 'environment=production'). |

**Responses:**

- **200**: Array of scheduled job data

### GET /api/scheduled-jobs/{namespace}/{jobId}

**Get a scheduled job**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

**Responses:**

- **200**: The scheduled job data

### DELETE /api/scheduled-jobs/{namespace}/{jobId}

**Delete a scheduled job**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

### POST /api/scheduled-jobs/{namespace}/{jobId}/suspend

**Suspend a scheduled job**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

### POST /api/scheduled-jobs/{namespace}/{jobId}/resume

**Resume a scheduled job**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

### POST /api/scheduled-jobs/{namespace}/{jobId}/run

**Run job**

Trigger a scheduled job run. Trigger a scheduled job to run immediately. Throws an error if an instance is already running and job spec does not allow concurrent runs.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

**Responses:**

- **200**: The job that was triggered
- **409**: Another instance is already running, job was not triggered

### POST /api/scheduled-jobs/{namespace}/{jobId}/schedule

**Update a scheduled job schedule**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schedule": {
      "description": "CRON schedule expression (e.g., '0 9 * * 1' for 9 AM every Monday).",
      "type": "string",
      "pattern": "^(?:(@(annually|yearly|monthly|weekly|daily|hourly))|((((\\d+,)+\\d+|((\\*|\\d+)(\\/|-)\\d+)|\\d+|\\*) ?){5,7}))$"
    }
  },
  "required": [
    "schedule"
  ]
}
```

**Responses:**

- **200**: The updated scheduled job

### PUT /api/scheduled-jobs/{namespace}/{jobId}/labels

**Update scheduled job labels**

Replace user-provided labels on a scheduled job

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| jobId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "labels": {
      "description": "The new labels to set on the job. Replaces all existing labels.",
      "type": "object",
      "propertyNames": {
        "type": "string",
        "maxLength": 100,
        "pattern": "^[a-zA-Z0-9._-]+$"
      },
      "additionalProperties": {
        "type": "string",
        "maxLength": 100,
        "pattern": "^[a-zA-Z0-9._-]*$"
      }
    }
  },
  "required": [
    "labels"
  ]
}
```

**Responses:**

- **200**: The scheduled job after labels have been updated

## Resource groups

The following endpoints manage resource groups. Resource groups are a Team or Enterprise feature.

### GET /api/organizations/{name}/resource-groups

**Get resource groups**

Retrieve accessible resource groups. Get all resource groups the user has access to.

Requires the org to be Enterprise

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Responses:**

- **200**: Resource groups the user has access to

### POST /api/organizations/{name}/resource-groups

**Create a resource group**

Create a new resource group in the organization.

Requires the org to be Enterprise

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "description": {
      "type": "string",
      "maxLength": 500
    },
    "users": {
      "default": [],
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "user": {
            "type": "string"
          },
          "role": {
            "anyOf": [
              {
                "enum": [
                  "admin",
                  "write",
                  "contributor",
                  "read",
                  "no_access"
                ]
              },
              {
                "description": "Custom role name",
                "type": "string"
              }
            ]
          }
        },
        "required": [
          "user",
          "role"
        ]
      }
    },
    "repos": {
      "default": [],
      "type": "array",
      "items": {
        "$ref": "#/components/schemas/RepoId"
      }
    },
    "autoJoin": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "enabled": {
              "const": true
            },
            "role": {
              "anyOf": [
                {
                  "enum": [
                    "admin",
                    "write",
                    "contributor",
                    "read",
                    "no_access"
                  ]
                },
                {
                  "description": "Custom role name",
                  "type": "string"
                }
              ]
            }
          },
          "required": [
            "enabled",
            "role"
          ]
        },
        {
          "type": "object",
          "properties": {
            "enabled": {
              "const": false
            }
          },
          "required": [
            "enabled"
          ]
        }
      ]
    }
  },
  "required": [
    "name"
  ]
}
```

**Responses:**

- **200**: The created resource group

## Paper pages

The following endpoint gets information about papers.

### POST /api/settings/papers/claim

**Claim paper authorship**

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "paperId": {
      "description": "ArXiv paper identifier being claimed.",
      "type": "string"
    },
    "claimAuthorId": {
      "description": "Author entry on the paper being claimed.",
      "type": "string",
      "minLength": 24,
      "maxLength": 24,
      "pattern": "^[0-9a-fA-F]{24}$"
    },
    "targetUserId": {
      "description": "HF user who should receive the claim.",
      "type": "string",
      "minLength": 24,
      "maxLength": 24,
      "pattern": "^[0-9a-fA-F]{24}$"
    }
  },
  "required": [
    "paperId"
  ]
}
```

**Responses:**

- **200**: Paper authorship claim result, including the claimed paper id

### GET /api/daily_papers

**Get Daily Papers**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| p | query | integer | No |  |
| limit | query | integer | No |  |
| date | query | string | No |  |
| week | query | string | No |  |
| month | query | string | No |  |
| submitter | query | string | No |  |
| sort | query | publishedAt \| trending | No |  |

**Responses:**

- **200**: List of daily papers

### GET /api/papers

**List papers**

List arXiv papers sorted by published date

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| cursor | query | string | No | Pagination cursor |
| limit | query | integer | No |  |

**Responses:**

- **200**: List of papers

### GET /api/papers/search

**Search papers**

Perform a hybrid semantic / full-text-search on papers

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| q | query | string | No |  |
| limit | query | integer | No |  |

### POST /api/papers/index

**Index a paper**

Index a paper from arXiv by its ID. If the paper is already indexed, only its authors can re-index it.

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "arxivId": {
      "description": "The arXiv ID of the paper to index (e.g. 2301.00001)",
      "type": "string",
      "pattern": "^\\d{4}\\.\\d{4,5}$"
    }
  },
  "required": [
    "arxivId"
  ]
}
```

**Responses:**

- **200**: Empty object on success

### GET /api/papers/{paperId}

**Get a paper**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| paperId | path | string | Yes |  |
| field | query | string | No |  |

**Responses:**

- **200**: Paper data

### POST /api/papers/{paperId}/links

**Update paper links**

Update the project page, GitHub repository, or submitting organization for a paper. Requires the requester to be the paper author, the Daily Papers submitter, or a papers admin.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| paperId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectPage": {
      "anyOf": [
        {
          "type": "string",
          "format": "uri"
        },
        {
          "type": "null"
        }
      ]
    },
    "githubRepo": {
      "anyOf": [
        {
          "type": "string",
          "format": "uri"
        },
        {
          "type": "null"
        }
      ]
    },
    "organizationId": {
      "anyOf": [
        {
          "type": "string",
          "minLength": 24,
          "maxLength": 24,
          "pattern": "^[0-9a-fA-F]{24}$"
        },
        {
          "type": "null"
        }
      ]
    }
  }
}
```

**Responses:**

- **200**: Paper links updated

## Collections

Use Collections to group repositories from the Hub (Models, Datasets, Spaces and Papers) on a dedicated page.

You can learn more about it in the Collections [guide](https://huggingface.co/docs/hub/collections). Collections can also be managed using the Python client (see [guide](https://huggingface.co/docs/huggingface_hub/main/en/guides/collections)).

### GET /api/collections/{namespace}/{slug}-{id}

**Get a collection**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |
| id | path | string | Yes |  |

**Responses:**

- **200**: The collection data

### PATCH /api/collections/{namespace}/{slug}-{id}

**Update a collection**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |
| id | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "position": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "private": {
      "type": "boolean"
    },
    "theme": {
      "enum": [
        "orange",
        "blue",
        "green",
        "purple",
        "pink",
        "indigo"
      ]
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 60
    },
    "description": {
      "type": "string",
      "maxLength": 150
    },
    "gating": {
      "anyOf": [
        {
          "const": false
        },
        {
          "type": "object",
          "properties": {
            "mode": {
              "const": "auto"
            }
          },
          "required": [
            "mode"
          ]
        },
        {
          "type": "object",
          "properties": {
            "mode": {
              "const": "manual"
            },
            "notifications": {
              "type": "object",
              "properties": {
                "mode": {
                  "enum": [
                    "bulk",
                    "real-time"
                  ]
                },
                "email": {
                  "type": "string"
                }
              },
              "required": [
                "mode"
              ]
            }
          },
          "required": [
            "mode",
            "notifications"
          ]
        }
      ]
    }
  }
}
```

**Responses:**

- **200**: The updated collection

### DELETE /api/collections/{namespace}/{slug}-{id}

**Delete a collection**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |
| id | path | string | Yes |  |

### GET /api/collections/{namespace}/{slug}

**Get a collection**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |

**Responses:**

- **200**: The collection data

### PATCH /api/collections/{namespace}/{slug}

**Update a collection**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "position": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "private": {
      "type": "boolean"
    },
    "theme": {
      "enum": [
        "orange",
        "blue",
        "green",
        "purple",
        "pink",
        "indigo"
      ]
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 60
    },
    "description": {
      "type": "string",
      "maxLength": 150
    },
    "gating": {
      "anyOf": [
        {
          "const": false
        },
        {
          "type": "object",
          "properties": {
            "mode": {
              "const": "auto"
            }
          },
          "required": [
            "mode"
          ]
        },
        {
          "type": "object",
          "properties": {
            "mode": {
              "const": "manual"
            },
            "notifications": {
              "type": "object",
              "properties": {
                "mode": {
                  "enum": [
                    "bulk",
                    "real-time"
                  ]
                },
                "email": {
                  "type": "string"
                }
              },
              "required": [
                "mode"
              ]
            }
          },
          "required": [
            "mode",
            "notifications"
          ]
        }
      ]
    }
  }
}
```

**Responses:**

- **200**: The updated collection

### DELETE /api/collections/{namespace}/{slug}

**Delete a collection**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |

### POST /api/collections/{namespace}/{slug}-{id}/items

**Add item**

Add an item to a collection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |
| id | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "item": {
      "type": "object",
      "properties": {
        "type": {
          "enum": [
            "paper",
            "collection",
            "space",
            "model",
            "dataset",
            "bucket"
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "type",
        "id"
      ]
    },
    "note": {
      "type": "string",
      "maxLength": 500
    }
  },
  "required": [
    "item"
  ]
}
```

**Responses:**

- **200**: The updated collection

### POST /api/collections/{namespace}/{slug}/items

**Add item**

Add an item to a collection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "item": {
      "type": "object",
      "properties": {
        "type": {
          "enum": [
            "paper",
            "collection",
            "space",
            "model",
            "dataset",
            "bucket"
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "type",
        "id"
      ]
    },
    "note": {
      "type": "string",
      "maxLength": 500
    }
  },
  "required": [
    "item"
  ]
}
```

**Responses:**

- **200**: The updated collection

### POST /api/collections/{namespace}/{slug}-{id}/items/batch

**Batch update items**

Batch update items in a collection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |
| id | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "action": {
        "enum": [
          "update"
        ]
      },
      "_id": {
        "type": "string",
        "minLength": 24,
        "maxLength": 24,
        "pattern": "^[0-9a-f]{24}$"
      },
      "data": {
        "type": "object",
        "properties": {
          "gallery": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "uri"
            }
          },
          "note": {
            "type": "string",
            "maxLength": 500
          },
          "position": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        }
      }
    },
    "required": [
      "action",
      "_id",
      "data"
    ]
  }
}
```

### POST /api/collections/{namespace}/{slug}/items/batch

**Batch update items**

Batch update items in a collection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "action": {
        "enum": [
          "update"
        ]
      },
      "_id": {
        "type": "string",
        "minLength": 24,
        "maxLength": 24,
        "pattern": "^[0-9a-f]{24}$"
      },
      "data": {
        "type": "object",
        "properties": {
          "gallery": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "uri"
            }
          },
          "note": {
            "type": "string",
            "maxLength": 500
          },
          "position": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        }
      }
    },
    "required": [
      "action",
      "_id",
      "data"
    ]
  }
}
```

### DELETE /api/collections/{namespace}/{slug}-{id}/items/{itemId}

**Delete item**

Delete an item from a collection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |
| id | path | string | Yes |  |
| itemId | path | string | Yes |  |

### DELETE /api/collections/{namespace}/{slug}/items/{slug}

**Delete item**

Delete an item from a collection

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| slug | path | string | Yes |  |
| slug | path | string | Yes |  |

### POST /api/collections

**Create a collection**

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 60
    },
    "description": {
      "type": "string",
      "maxLength": 150
    },
    "namespace": {
      "type": "string"
    },
    "item": {
      "type": "object",
      "properties": {
        "type": {
          "enum": [
            "paper",
            "collection",
            "space",
            "model",
            "dataset",
            "bucket"
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "type",
        "id"
      ]
    },
    "private": {
      "description": "If not provided, the collection will be public. This field will respect the organization's visibility setting.",
      "type": "boolean"
    }
  },
  "required": [
    "title",
    "namespace"
  ]
}
```

**Responses:**

- **200**: The created collection
- **409**: The collection already exists

### GET /api/collections

**Get collections**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| item | query | string | No |  |
| owner | query | string | No |  |
| q | query | string | No |  |
| sort | query | upvotes \| lastModified \| trending | No |  |
| cursor | query | string | No |  |
| expand | query | string | No |  |
| limit | query | number | No |  |

**Responses:**

- **200**: The collection data

## Buckets

Git-free storage buckets for files, powered by Xet. Buckets provide simple file storage without git versioning.

### POST /api/buckets/{namespace}/{repo}/lfs-files/duplicate

**Duplicate xet files**

Duplicate xet-stored files from this repo (source) into another repo (target) by xet hash, without re-uploading file bytes. The caller must then commit the files with their sha256/size as usual.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "target": {
      "type": "object",
      "properties": {
        "type": {
          "enum": [
            "dataset",
            "model",
            "space",
            "kernel"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "type",
        "name"
      ]
    },
    "files": {
      "minItems": 1,
      "maxItems": 1000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "xetHash": {
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-fA-F]{64}$"
          },
          "sha256": {
            "type": "string",
            "minLength": 64,
            "maxLength": 64,
            "pattern": "^[0-9a-fA-F]{64}$"
          },
          "filename": {
            "type": "string",
            "maxLength": 1000
          }
        },
        "required": [
          "xetHash",
          "sha256"
        ]
      }
    }
  },
  "required": [
    "target",
    "files"
  ]
}
```

**Responses:**

- **200**: Duplicate xet files response
- **207**: Duplicate xet files response

### GET /api/buckets/{namespace}/{repo}/xet-write-token

**Xet write token**

Get a write short-lived access token for XET upload

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The response from the getXetWriteAccessToken endpoint.

### GET /api/buckets/{namespace}/{repo}/xet-read-token

**Xet read token**

Get a read short-lived access token for XET

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The response from the getXetReadAccessToken endpoint.

### POST /api/buckets/{namespace}/{repo}/resource-group

**Add resource group**

Add the repository to a resource group

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "resourceGroupId": {
      "description": "The resource group to add the repository to, if null, the repository will be removed from the resource group",
      "anyOf": [
        {
          "type": "string",
          "minLength": 24,
          "maxLength": 24,
          "pattern": "^[0-9a-f]{24}$"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "resourceGroupId"
  ]
}
```

**Responses:**

- **200**: Minimal information about the repository

### GET /api/buckets/{namespace}/{repo}/resource-group

**Get resource group**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: The resource group of the repository

### POST /api/buckets/{namespace}/{repo}

**Create bucket**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "Bucket creation options",
  "type": "object",
  "properties": {
    "private": {
      "description": "Bucket visibility. Defaults to public",
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "null"
        }
      ]
    },
    "resourceGroupId": {
      "type": "string",
      "minLength": 24,
      "maxLength": 24,
      "pattern": "^[0-9a-fA-F]{24}$"
    },
    "cdn": {
      "description": "CDN pre-warming regions",
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "provider": {
            "enum": [
              "gcp",
              "aws"
            ]
          },
          "region": {
            "enum": [
              "us",
              "eu"
            ]
          }
        },
        "required": [
          "provider",
          "region"
        ]
      }
    },
    "region": {
      "description": "The region where the bucket is hosted.",
      "enum": [
        "us",
        "eu"
      ]
    }
  }
}
```

**Responses:**

- **200**: Bucket created, url is given
- **409**: Bucket already exists, url is given

### DELETE /api/buckets/{namespace}/{repo}

**Delete bucket**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

### GET /api/buckets/{namespace}/{repo}

**Get bucket details**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: Bucket overview information

### PUT /api/buckets/{namespace}/{repo}/settings

**Update bucket settings**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "private": {
      "anyOf": [
        {
          "type": "boolean"
        },
        {}
      ]
    },
    "cdnRegions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "provider": {
            "enum": [
              "gcp",
              "aws"
            ]
          },
          "region": {
            "enum": [
              "us",
              "eu"
            ]
          }
        },
        "required": [
          "provider",
          "region"
        ]
      }
    }
  },
  "required": [
    "cdnRegions"
  ]
}
```

**Responses:**

- **200**: The updated bucket settings.

### GET /api/buckets/{namespace}

**List namespace buckets**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| search | query | string | No |  |

**Responses:**

- **200**: List of buckets

### GET /buckets/{namespace}/{repo}/resolve/{path}

**Retrieve information about a file in a bucket**

Returns file metadata including size, hash, and links to XET authentication

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| noContentDisposition | query | string | No |  |
| download | query | string | No |  |
| Accept | header | string | No | Returns json information about the XET file info |

**Responses:**

- **200**: XET file info returned when the Accept header is set to `application/vnd.xet-fileinfo+json`. Otherwise, a 302 redirect is returned.
- **302**: Redirection to file on the xet bridge (default when no specific Accept header is set)
- **400**: File path required
- **404**: Bucket or file not found

### POST /api/buckets/{namespace}/{repo}/batch

**Batch file operations**

Accepts NDJSON (newline-delimited JSON) where each line is an addFile, copyFile, or deleteFile instruction.
All add/copy operations must come before all delete operations.

JSON-lines payload:
```json
	'{"type":"addFile","path":"...","xetHash":"...","mtime":...,"contentType":"..."}' +
	'{"type":"copyFile","path":"...","xetHash":"...","sourceRepoType":"...","sourceRepoId":"..."}' +
	'{"type":"deleteFile","path":"..."}'
```

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Responses:**

- **200**: Batch operation status
- **422**: Batch operation status

### GET /api/buckets/{namespace}/{repo}/tree/{path}

**List files**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |
| path | path | string | Yes | Wildcard path parameter |
| limit | query | integer | No |  |
| cursor | query | string | No | Pagination cursor |
| recursive | query | string | No | When false, returns collapsed directory entries instead of listing all files recursively. The number of entries returned can then be less than the limit, but there will always be a pagination link if there are more entries. Note: non-recursive listing hasn't a strong consistency guarantees. |

**Responses:**

- **200**: List of files and directories

### POST /api/buckets/{namespace}/{repo}/paths-info

**List paths info**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| repo | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "paths": {
      "anyOf": [
        {
          "maxItems": 2000,
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        {
          "type": "string"
        }
      ]
    }
  },
  "required": [
    "paths"
  ]
}
```

**Responses:**

- **200**: List of found files (missing paths are omitted)

## Notifications

The following endpoints fetch Hub notifications.

### GET /api/notifications

**List notifications**

List notifications for the user

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| p | query | integer | No |  |
| readStatus | query | all \| unread | No |  |
| repoType | query | dataset \| model \| space \| bucket \| kernel | No |  |
| repoName | query | string | No |  |
| postAuthor | query | string | No |  |
| paperId | query | string | No |  |
| articleId | query | string | No |  |
| mention | query | all \| participating \| mentions | No |  |
| lastUpdate | query | string | No |  |

**Responses:**

- **200**: The notifications for the user

### DELETE /api/notifications

**Delete notifications**

Delete notifications, either by specifying discussionIds or by applying to all notifications with search parameters

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| p | query | integer | No |  |
| readStatus | query | all \| unread | No |  |
| repoType | query | dataset \| model \| space \| bucket \| kernel | No |  |
| repoName | query | string | No |  |
| postAuthor | query | string | No |  |
| paperId | query | string | No |  |
| articleId | query | string | No |  |
| mention | query | all \| participating \| mentions | No |  |
| lastUpdate | query | string | No |  |
| applyToAll | query | string | No |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "discussionIds": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 24,
        "maxLength": 24,
        "pattern": "^[0-9a-f]{24}$"
      }
    }
  }
}
```

### POST /api/notifications/mark-as-read

**Change read status**

Mark discussions as read or unread. If `applyToAll` is true, all notifications for the user matching the search parameters will be marked as read or unread.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| p | query | integer | No |  |
| readStatus | query | all \| unread | No |  |
| repoType | query | dataset \| model \| space \| bucket \| kernel | No |  |
| repoName | query | string | No |  |
| postAuthor | query | string | No |  |
| paperId | query | string | No |  |
| articleId | query | string | No |  |
| mention | query | all \| participating \| mentions | No |  |
| lastUpdate | query | string | No |  |
| applyToAll | query | string | No |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "discussionIds": {
      "default": [],
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "read": {
      "default": true,
      "type": "boolean"
    }
  }
}
```

### PATCH /api/settings/notifications

**Update notification settings**

Update notification settings for the user

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "notifications": {
      "type": "object",
      "properties": {
        "announcements": {
          "type": "boolean"
        },
        "arxiv_paper_activity": {
          "type": "boolean"
        },
        "daily_papers_digest": {
          "type": "boolean"
        },
        "discussions_participating": {
          "type": "boolean"
        },
        "discussions_watched": {
          "type": "boolean"
        },
        "gated_user_access_request": {
          "type": "boolean"
        },
        "inference_endpoint_status": {
          "type": "boolean"
        },
        "launch_autonlp": {
          "type": "boolean"
        },
        "launch_spaces": {
          "type": "boolean"
        },
        "launch_prepaid_credits": {
          "type": "boolean"
        },
        "launch_training_cluster": {
          "type": "boolean"
        },
        "org_request": {
          "type": "boolean"
        },
        "org_suggestions": {
          "type": "boolean"
        },
        "org_verified_suggestions": {
          "type": "boolean"
        },
        "org_suggestions_to_create": {
          "type": "boolean"
        },
        "posts_participating": {
          "type": "boolean"
        },
        "user_follows": {
          "type": "boolean"
        },
        "secret_detected": {
          "type": "boolean"
        },
        "web_discussions_participating": {
          "type": "boolean"
        },
        "web_discussions_watched": {
          "type": "boolean"
        },
        "web_posts_participating": {
          "type": "boolean"
        },
        "product_updates_after": {
          "type": "string",
          "format": "date-time",
          "pattern": "^((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?(Z)$"
        },
        "api_inference_sunset": {
          "type": "boolean"
        },
        "locked_out": {
          "type": "boolean"
        }
      }
    },
    "prepaidAmount": {
      "description": "To be provided when enabling launch_prepaid_credits",
      "type": "string",
      "maxLength": 24
    }
  },
  "required": [
    "notifications"
  ]
}
```

### PATCH /api/settings/watch

**Update watch settings**

Update watch settings for the user. Get notified when discussions happen on your watched items.

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "delete": {
      "default": [],
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "type": {
            "enum": [
              "org",
              "user",
              "repo"
            ]
          }
        },
        "required": [
          "id",
          "type"
        ]
      }
    },
    "add": {
      "default": [],
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "type": {
            "enum": [
              "org",
              "user",
              "repo"
            ]
          }
        },
        "required": [
          "id",
          "type"
        ]
      }
    }
  }
}
```

## Inference Endpoints

Manage inference endpoints.

### POST /api/inference-endpoints/{namespace}/auth-check/{perms}

**Check access**

Check if the user has access to the inference endpoint

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| perms | path | string | Yes |  |
| own | query | string | No |  |
| is_creator | query | string | No |  |
| creator_id | query | string | No |  |
| incur_cost | query | string | No |  |
| resource_group_id | query | string | No |  |
| repo_id | query | string | No |  |

**Responses:**

- **200**: The user has access to the inference endpoint/resource
- **207**: The user has access to the resource, but the endpoint name is restricted by pattern restrictions. Can only be returned if `endpoint` is not provided in the path

### POST /api/inference-endpoints/{namespace}/{endpoint}/auth-check/{perms}

**Check access**

Check if the user has access to the inference endpoint

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| namespace | path | string | Yes |  |
| endpoint | path | string | Yes |  |
| perms | path | string | Yes |  |
| own | query | string | No |  |
| is_creator | query | string | No |  |
| creator_id | query | string | No |  |
| incur_cost | query | string | No |  |
| resource_group_id | query | string | No |  |
| repo_id | query | string | No |  |

**Responses:**

- **200**: The user has access to the inference endpoint/resource
- **207**: The user has access to the resource, but the endpoint name is restricted by pattern restrictions. Can only be returned if `endpoint` is not provided in the path

## OAuth

The following endpoints are for use with OAuth.

### POST /oauth/register

**Register a new OAuth app**

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "redirect_uris": {
      "type": "array",
      "items": {
        "type": "string",
        "format": "uri"
      }
    },
    "client_name": {
      "type": "string"
    },
    "client_uri": {
      "type": "string",
      "format": "uri"
    },
    "logo_uri": {
      "type": "string",
      "format": "uri"
    },
    "scope": {
      "type": "string"
    },
    "contacts": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "token_endpoint_auth_method": {
      "enum": [
        "client_secret_basic",
        "none",
        "client_secret_post"
      ]
    },
    "software_id": {
      "type": "string"
    },
    "software_version": {
      "type": "string"
    }
  }
}
```

**Responses:**

- **201**: Details of the OAuth app that was created

### POST /oauth/device

**Initiate device authorization**

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "Initiate device authorization as per https://datatracker.ietf.org/doc/html/rfc8628#section-3.1",
  "type": "object",
  "properties": {
    "client_id": {
      "type": "string"
    },
    "scope": {
      "type": "string"
    }
  },
  "required": [
    "client_id"
  ]
}
```

**Responses:**

- **200**: Details of the device code that was created as per https://datatracker.ietf.org/doc/html/rfc8628#section-3.2

### GET /oauth/userinfo

**Get user info**

Get information about the user. Only available through oauth access tokens. Information varies depending on the scope of the oauth app and what permissions the user granted to the oauth app.

**Responses:**

- **200**: User info

### POST /oauth/userinfo

**Get user info**

Get information about the user. Only available through oauth access tokens. Information varies depending on the scope of the oauth app and what permissions the user granted to the oauth app.

**Responses:**

- **200**: User info

## Documentation

The following endpoints are for interacting with the Hub's documentation.

### GET /api/docs

**List docs**

Get list of available documentation

**Responses:**

- **200**: List of available documentation

### GET /api/docs/search

**Search docs**

Search any Hugging Face documentation

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| q | query | string | Yes |  |
| product | query | hub \| transformers \| diffusers \| datasets \| gradio \| trackio \| smolagents \| huggingface_hub \| cli \| huggingface.js \| transformers.js \| inference-providers \| inference-endpoints \| peft \| accelerate \| optimum \| optimum-habana \| optimum-neuron \| optimum-intel \| optimum-executorch \| optimum-tpu \| tokenizers \| llm-course \| context-course \| robotics-course \| mcp-course \| smol-course \| agents-course \| deep-rl-course \| computer-vision-course \| evaluate \| tasks \| dataset-viewer \| trl \| simulate \| sagemaker \| timm \| safetensors \| tgi \| setfit \| audio-course \| lerobot \| reachy_mini \| autotrain \| tei \| bitsandbytes \| cookbook \| sentence_transformers \| ml-games-course \| diffusion-course \| ml-for-3d-course \| chat-ui \| leaderboards \| lighteval \| argilla \| distilabel \| microsoft-azure \| kernels \| google-cloud \| xet | No |  |
| limit | query | integer | No |  |

**Responses:**

- **200**: Search results

### GET /api/docs/search/full-text

**Full-text search docs**

Full-text search across Hugging Face documentation

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| q | query | string | Yes |  |
| limit | query | integer | No |  |
| domain | query | string | No |  |

**Responses:**

- **200**: Full-text search results

## Webhooks

The following endpoints are for use with webhooks.

### GET /api/settings/webhooks

**List webhooks**

**Responses:**

- **200**: Webhooks

### POST /api/settings/webhooks

**Create webhook**

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "watched": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "enum": [
              "dataset",
              "model",
              "space",
              "bucket",
              "kernel",
              "user",
              "org"
            ]
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "type",
          "name"
        ]
      }
    },
    "url": {
      "type": "string",
      "format": "uri"
    },
    "job": {
      "type": "object",
      "properties": {
        "spaceId": {
          "type": "string"
        },
        "dockerImage": {
          "type": "string"
        },
        "arguments": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "command": {
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "environment": {
          "default": {},
          "type": "object",
          "propertyNames": {
            "type": "string",
            "pattern": "^[a-zA-Z][_a-zA-Z0-9]+$"
          },
          "additionalProperties": {
            "type": "string"
          }
        },
        "secrets": {
          "type": "object",
          "propertyNames": {
            "type": "string",
            "pattern": "^[a-zA-Z][_a-zA-Z0-9]*$"
          },
          "additionalProperties": {
            "type": "string"
          }
        },
        "flavor": {
          "enum": [
            "cpu-basic",
            "cpu-upgrade",
            "cpu-performance",
            "cpu-xl",
            "sprx8",
            "zero-a10g",
            "t4-small",
            "t4-medium",
            "l4x1",
            "l4x4",
            "l40sx1",
            "l40sx4",
            "l40sx8",
            "a10g-small",
            "a10g-large",
            "a10g-largex2",
            "a10g-largex4",
            "a100-large",
            "a100x4",
            "a100x8",
            "h200",
            "h200x2",
            "h200x4",
            "h200x8",
            "rtx-pro-6000",
            "rtx-pro-6000x2",
            "rtx-pro-6000x4",
            "rtx-pro-6000x8",
            "inf2x6"
          ]
        },
        "arch": {
          "enum": [
            "amd64",
            "arm64"
          ]
        },
        "timeoutSeconds": {
          "default": null,
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "attempts": {
          "description": "Max number of attempts to make. For example, if you set this to 3, the job will be retried up to 2 times if it fails.",
          "default": 1,
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "labels": {
          "description": "Labels for the job as key-value pairs. Both keys and values must be max 100 characters and contain only alphanumeric characters, dots, dashes, and underscores.",
          "type": "object",
          "propertyNames": {
            "type": "string",
            "maxLength": 100,
            "pattern": "^[a-zA-Z0-9._-]+$"
          },
          "additionalProperties": {
            "type": "string",
            "maxLength": 100,
            "pattern": "^[a-zA-Z0-9._-]*$"
          }
        },
        "volumes": {
          "description": "HuggingFace Buckets or Repos to mount as volumes in the job container.",
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "type": {
                "enum": [
                  "bucket",
                  "model",
                  "dataset",
                  "space"
                ]
              },
              "source": {
                "description": "Source identifier, e.g. 'username/my-bucket' or 'username/my-model'",
                "type": "string"
              },
              "mountPath": {
                "description": "Mount path inside the container, e.g. '/data'",
                "type": "string",
                "pattern": "^\\/.*"
              },
              "revision": {
                "description": "Git revision (only for repos, defaults to 'main')",
                "type": "string"
              },
              "readOnly": {
                "description": "Read-only mount (true for repos, false default for buckets)",
                "type": "boolean"
              },
              "path": {
                "description": "Subfolder prefix inside the bucket/repo to mount, e.g. 'path/to/dir'",
                "type": "string"
              }
            },
            "required": [
              "type",
              "source",
              "mountPath"
            ]
          }
        },
        "expose": {
          "description": "When `enabled`, expose every port the job's container listens on through the jobs proxy. Each port is reachable at `https://<job_id>--<port>.jobs.huggingface.tech`. Any port the container binds to is proxied automatically; you do not need to declare specific ports. Access always requires a HF token with read access to the job's namespace.",
          "type": "object",
          "properties": {
            "enabled": {
              "default": false,
              "type": "boolean"
            }
          }
        }
      },
      "required": [
        "flavor"
      ]
    },
    "jobSourceId": {
      "type": "string"
    },
    "domains": {
      "minItems": 1,
      "type": "array",
      "items": {
        "enum": [
          "repo",
          "discussion"
        ]
      }
    },
    "secret": {
      "type": "string",
      "pattern": "^[\\x20-\\x7F]*$"
    }
  },
  "required": [
    "watched",
    "domains"
  ]
}
```

**Responses:**

- **200**: Created webhook

### GET /api/settings/webhooks/{webhookId}

**Get webhook**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| webhookId | path | string | Yes |  |

**Responses:**

- **200**: Webhook

### POST /api/settings/webhooks/{webhookId}

**Update webhook**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| webhookId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "watched": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "enum": [
              "dataset",
              "model",
              "space",
              "bucket",
              "kernel",
              "user",
              "org"
            ]
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "type",
          "name"
        ]
      }
    },
    "url": {
      "type": "string",
      "format": "uri"
    },
    "job": {
      "type": "object",
      "properties": {
        "spaceId": {
          "type": "string"
        },
        "dockerImage": {
          "type": "string"
        },
        "arguments": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "command": {
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "environment": {
          "default": {},
          "type": "object",
          "propertyNames": {
            "type": "string",
            "pattern": "^[a-zA-Z][_a-zA-Z0-9]+$"
          },
          "additionalProperties": {
            "type": "string"
          }
        },
        "secrets": {
          "type": "object",
          "propertyNames": {
            "type": "string",
            "pattern": "^[a-zA-Z][_a-zA-Z0-9]*$"
          },
          "additionalProperties": {
            "type": "string"
          }
        },
        "flavor": {
          "enum": [
            "cpu-basic",
            "cpu-upgrade",
            "cpu-performance",
            "cpu-xl",
            "sprx8",
            "zero-a10g",
            "t4-small",
            "t4-medium",
            "l4x1",
            "l4x4",
            "l40sx1",
            "l40sx4",
            "l40sx8",
            "a10g-small",
            "a10g-large",
            "a10g-largex2",
            "a10g-largex4",
            "a100-large",
            "a100x4",
            "a100x8",
            "h200",
            "h200x2",
            "h200x4",
            "h200x8",
            "rtx-pro-6000",
            "rtx-pro-6000x2",
            "rtx-pro-6000x4",
            "rtx-pro-6000x8",
            "inf2x6"
          ]
        },
        "arch": {
          "enum": [
            "amd64",
            "arm64"
          ]
        },
        "timeoutSeconds": {
          "default": null,
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "attempts": {
          "description": "Max number of attempts to make. For example, if you set this to 3, the job will be retried up to 2 times if it fails.",
          "default": 1,
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "labels": {
          "description": "Labels for the job as key-value pairs. Both keys and values must be max 100 characters and contain only alphanumeric characters, dots, dashes, and underscores.",
          "type": "object",
          "propertyNames": {
            "type": "string",
            "maxLength": 100,
            "pattern": "^[a-zA-Z0-9._-]+$"
          },
          "additionalProperties": {
            "type": "string",
            "maxLength": 100,
            "pattern": "^[a-zA-Z0-9._-]*$"
          }
        },
        "volumes": {
          "description": "HuggingFace Buckets or Repos to mount as volumes in the job container.",
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "type": {
                "enum": [
                  "bucket",
                  "model",
                  "dataset",
                  "space"
                ]
              },
              "source": {
                "description": "Source identifier, e.g. 'username/my-bucket' or 'username/my-model'",
                "type": "string"
              },
              "mountPath": {
                "description": "Mount path inside the container, e.g. '/data'",
                "type": "string",
                "pattern": "^\\/.*"
              },
              "revision": {
                "description": "Git revision (only for repos, defaults to 'main')",
                "type": "string"
              },
              "readOnly": {
                "description": "Read-only mount (true for repos, false default for buckets)",
                "type": "boolean"
              },
              "path": {
                "description": "Subfolder prefix inside the bucket/repo to mount, e.g. 'path/to/dir'",
                "type": "string"
              }
            },
            "required": [
              "type",
              "source",
              "mountPath"
            ]
          }
        },
        "expose": {
          "description": "When `enabled`, expose every port the job's container listens on through the jobs proxy. Each port is reachable at `https://<job_id>--<port>.jobs.huggingface.tech`. Any port the container binds to is proxied automatically; you do not need to declare specific ports. Access always requires a HF token with read access to the job's namespace.",
          "type": "object",
          "properties": {
            "enabled": {
              "default": false,
              "type": "boolean"
            }
          }
        }
      },
      "required": [
        "flavor"
      ]
    },
    "jobSourceId": {
      "type": "string"
    },
    "domains": {
      "minItems": 1,
      "type": "array",
      "items": {
        "enum": [
          "repo",
          "discussion"
        ]
      }
    },
    "secret": {
      "type": "string",
      "pattern": "^[\\x20-\\x7F]*$"
    }
  },
  "required": [
    "watched",
    "domains"
  ]
}
```

**Responses:**

- **200**: Updated webhook

### DELETE /api/settings/webhooks/{webhookId}

**Delete webhook**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| webhookId | path | string | Yes |  |

**Responses:**

- **200**: Deleted webhook

### POST /api/settings/webhooks/{webhookId}/{action}

**Enable/disable webhook**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| webhookId | path | string | Yes |  |
| action | path | string | Yes |  |

**Responses:**

- **200**: Updated webhook

### POST /api/settings/webhooks/{webhookId}/replay/{logId}

**Replay webhook log**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| webhookId | path | string | Yes |  |
| logId | path | string | Yes |  |

**Responses:**

- **200**: Replay response

## SCIM

Use the SCIM API to control and manage your hub Enterprise organization manage members' access.
## Authentication

- Must be organization owner
- Use Access token with write permission on organization
- Organization must be Enterprise Plus

## Key Attribute Matching

- Microsoft Entra ID (Azure AD)
	* SAML: `http://schemas.microsoft.com/identity/claims/objectidentifier`
	* SCIM: `externalId`
- Other Identity Providers
	* SAML: `NameID` or `unique identifier`
	* SCIM: `externalId`

## Supported SCIM User Attributes

| Attribute | Description |
|---|---|
| `userName` | Username for the user |
| `name.givenName` | First name |
| `name.familyName` | Last name |
| `emails` | Array of user emails; we don't support email types |
| `externalId` | IDP provider's unique identifier |
| `id` | Hugging Face SCIM endpoint identifier |
| `active` | Boolean for provisioning status |



### GET /api/organizations/{name}/scim/v2/ServiceProviderConfig

**Get SCIM Service Provider Configuration**

Returns the SCIM 2.0 Service Provider configuration, describing the server's capabilities and supported authentication schemes.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Responses:**

- **200**: SCIM Service Provider Configuration

### GET /api/organizations/{name}/scim/v2/ResourceTypes

**Get SCIM Resource Types**

Returns the list of SCIM 2.0 resource types supported by this server (User and Group).

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Responses:**

- **200**: SCIM Resource Types

### GET /api/organizations/{name}/scim/v2/Schemas

**Get SCIM Schemas**

Returns the SCIM 2.0 schema definitions for User and Group resources.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Responses:**

- **200**: SCIM Schema Definitions

### GET /api/organizations/{name}/scim/v2/Schemas/{schemaId}

**Get SCIM Schema by ID**

Returns a single SCIM 2.0 schema definition by its schema URI.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| schemaId | path | string | Yes |  |

**Responses:**

- **200**: SCIM Schema Definition

### GET /api/organizations/{name}/scim/v2/Users

**List SCIM users**

Retrieves a paginated list of all organization members who have been set up, including disabled users. If you provide the filter parameter, the resources for all matching members are returned.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| startIndex | query | number | No |  |
| count | query | number | No |  |
| filter | query | string | No | You can filter results using the equals operator (eq) to find items that match specific values like `id`, `userName`, `emails`, and `externalId`. For example, to find a user named Bob, use this search: `?filter=userName%20eq%20Bob` |

**Responses:**

- **200**: SCIM User List

### POST /api/organizations/{name}/scim/v2/Users

**Create a SCIM user**

Creates a new user in the organization. If the user already exists, only `active` field will be updated to provision the user.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schemas": {
      "examples": [
        [
          "urn:ietf:params:scim:schemas:core:2.0:User"
        ]
      ],
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "userName": {
      "description": "Username for the user, it should respect the hub rules: No consecutive dashes, No digit-only, Does not start or end with a dash, Only dashes, letters or numbers, Not 24 chars hex string",
      "type": "string",
      "minLength": 2,
      "maxLength": 42,
      "pattern": "^\\b(?!\\d+$)(?![0-9a-fA-F]{24}$)([a-zA-Z0-9]|-(?!-))+\\b$"
    },
    "emails": {
      "minItems": 1,
      "maxItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string",
            "format": "email",
            "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
          }
        },
        "required": [
          "value"
        ]
      }
    },
    "name": {
      "type": "object",
      "properties": {
        "givenName": {
          "type": "string",
          "minLength": 1
        },
        "familyName": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "givenName",
        "familyName"
      ]
    },
    "active": {
      "default": true,
      "type": "boolean"
    },
    "externalId": {
      "description": "External ID for the user, it must be unique within the organization and is required for managed users",
      "type": "string"
    }
  },
  "required": [
    "schemas",
    "userName",
    "emails",
    "name",
    "externalId"
  ]
}
```

**Responses:**

- **201**: SCIM User
- **409**: SCIM User already exists

### GET /api/organizations/{name}/scim/v2/Users/{userId}

**Get a SCIM user**

Retrieves a SCIM user by their ID.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| userId | path | string | Yes |  |

**Responses:**

- **200**: SCIM User

### PATCH /api/organizations/{name}/scim/v2/Users/{userId}

**Update SCIM user**

Update an attribute of a SCIM user. Modify individual attributes using Operations format. Just provide the changes you want to make using add, remove (only `externalId` is supported), or replace operations.
 If you set `active` to `false`, the user will be deprovisioned from the organization. 
Complicated SCIM `path` values are not supported like `emails[type eq 'work'].value`.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| userId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schemas": {
      "examples": [
        [
          "urn:ietf:params:scim:api:messages:2.0:PatchOp"
        ]
      ],
      "minItems": 1,
      "type": "array",
      "items": {
        "const": "urn:ietf:params:scim:api:messages:2.0:PatchOp"
      }
    },
    "Operations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "op": {
            "type": "string"
          },
          "path": {
            "enum": [
              "active",
              "externalId",
              "userName",
              "emails[type eq \"work\"].value",
              "name.givenName",
              "name.familyName"
            ]
          },
          "value": {}
        },
        "required": [
          "op",
          "value"
        ]
      }
    }
  },
  "required": [
    "schemas",
    "Operations"
  ]
}
```

**Responses:**

- **200**: SCIM User
- **409**: User already exists

### PUT /api/organizations/{name}/scim/v2/Users/{userId}

**Update a SCIM user**

Updates a provisioned user, you'll need to provide all their information fresh - just like setting them up for the first time. Any details you don't include will be automatically removed, so make sure to include everything they need to keep their account running smoothly. Setting `active` to `false` will deprovision the user from the organization.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| userId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schemas": {
      "examples": [
        [
          "urn:ietf:params:scim:schemas:core:2.0:User"
        ]
      ],
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "userName": {
      "description": "Username for the user, it should respect the hub rules: No consecutive dashes, No digit-only, Does not start or end with a dash, Only dashes, letters or numbers, Not 24 chars hex string",
      "type": "string",
      "minLength": 2,
      "maxLength": 42,
      "pattern": "^\\b(?!\\d+$)(?![0-9a-fA-F]{24}$)([a-zA-Z0-9]|-(?!-))+\\b$"
    },
    "emails": {
      "maxItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string",
            "format": "email",
            "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
          }
        },
        "required": [
          "value"
        ]
      }
    },
    "name": {
      "type": "object",
      "properties": {
        "givenName": {
          "type": "string",
          "minLength": 1
        },
        "familyName": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "givenName",
        "familyName"
      ]
    },
    "active": {
      "default": true,
      "type": "boolean"
    },
    "externalId": {
      "type": "string"
    }
  },
  "required": [
    "schemas",
    "userName",
    "emails",
    "name",
    "externalId"
  ]
}
```

**Responses:**

- **200**: SCIM User
- **409**: User already exists

### DELETE /api/organizations/{name}/scim/v2/Users/{userId}

**Delete a SCIM user**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| userId | path | string | Yes |  |

**Responses:**

- **204**: User deleted

### GET /api/organizations/{name}/scim/v2/Groups

**List SCIM groups**

Get a list of SCIM groups. Retrieves a paginated list of all organization groups. If you provide the filter parameter, the resources for all matching groups are returned.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| startIndex | query | number | No |  |
| count | query | number | No |  |
| filter | query | string | No |  |
| excludedAttributes | query | string | No |  |

**Responses:**

- **200**: SCIM Group List

### POST /api/organizations/{name}/scim/v2/Groups

**Create a SCIM group**

Creates a new group in the organization. The group name must be unique within the organization.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "displayName": {
      "type": "string"
    },
    "externalId": {
      "type": "string"
    },
    "members": {
      "description": "Array of SCIM user ids",
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string",
            "minLength": 24,
            "maxLength": 24,
            "pattern": "^[0-9a-fA-F]{24}$"
          }
        },
        "required": [
          "value"
        ]
      }
    }
  },
  "required": [
    "displayName",
    "members"
  ]
}
```

**Responses:**

- **201**: SCIM Group
- **409**: Group already exists

### GET /api/organizations/{name}/scim/v2/Groups/{groupId}

**Get a SCIM group**

Retrieves a group by its ID. If you provide the `excludedAttributes` parameter, the `members` attribute is not returned.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| groupId | path | string | Yes |  |
| excludedAttributes | query | string | No |  |

**Responses:**

- **200**: SCIM Group

### PUT /api/organizations/{name}/scim/v2/Groups/{groupId}

**Update a SCIM group**

Updates a group by its ID. The group name must be unique within the organization.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| groupId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schemas": {
      "examples": [
        [
          "urn:ietf:params:scim:schemas:core:2.0:Group"
        ]
      ],
      "minItems": 1,
      "type": "array",
      "items": {
        "const": "urn:ietf:params:scim:schemas:core:2.0:Group"
      }
    },
    "displayName": {
      "type": "string"
    },
    "externalId": {
      "type": "string"
    },
    "members": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string",
            "minLength": 24,
            "maxLength": 24,
            "pattern": "^[0-9a-fA-F]{24}$"
          }
        },
        "required": [
          "value"
        ]
      }
    }
  },
  "required": [
    "schemas",
    "displayName",
    "members"
  ]
}
```

**Responses:**

- **200**: SCIM Group

### PATCH /api/organizations/{name}/scim/v2/Groups/{groupId}

**Update SCIM group**

Update attributes of a SCIM group. Updates individual attributes using Operations format. Just provide the changes you want to make using add, remove (only `members` is supported), or replace operations.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| groupId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schemas": {
      "examples": [
        [
          "urn:ietf:params:scim:api:messages:2.0:PatchOp"
        ]
      ],
      "minItems": 1,
      "type": "array",
      "items": {
        "const": "urn:ietf:params:scim:api:messages:2.0:PatchOp"
      }
    },
    "Operations": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "op": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "value": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "value": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "value"
                  ]
                }
              }
            },
            "required": [
              "op",
              "path"
            ]
          },
          {
            "type": "object",
            "properties": {
              "op": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "value": {}
            },
            "required": [
              "op",
              "value"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "schemas",
    "Operations"
  ]
}
```

**Responses:**

- **200**: SCIM Group

### DELETE /api/organizations/{name}/scim/v2/Groups/{groupId}

**Delete a SCIM group**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| groupId | path | string | Yes |  |

**Responses:**

- **204**: SCIM Group deleted

### GET /api/organizations/{name}/scim-provisioning/v2/Users

**List SCIM-managed users**

Retrieves a paginated list of organization members and pending invitations managed by SCIM for non-managed organizations.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| startIndex | query | number | No |  |
| count | query | number | No |  |
| filter | query | string | No | You can filter results using the equals operator (eq) to find items that match specific values like `id`, `userName`, `emails`, and `externalId`. For example, to find a user named Bob, use this search: `?filter=userName%20eq%20Bob` |

**Responses:**

- **200**: SCIM User List

### POST /api/organizations/{name}/scim-provisioning/v2/Users

**Create a SCIM provisioning user invitation**

Creates an invitation for a user to join the organization. The user must have an existing Hugging Face account.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schemas": {
      "examples": [
        [
          "urn:ietf:params:scim:schemas:core:2.0:User"
        ]
      ],
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "userName": {
      "description": "Username of the existing Hugging Face user",
      "type": "string",
      "minLength": 2,
      "maxLength": 42,
      "pattern": "^\\b(?!\\d+$)(?![0-9a-fA-F]{24}$)([a-zA-Z0-9]|-(?!-))+\\b$"
    },
    "emails": {
      "minItems": 1,
      "maxItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string",
            "format": "email",
            "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
          }
        },
        "required": [
          "value"
        ]
      }
    },
    "active": {
      "default": true,
      "type": "boolean"
    },
    "externalId": {
      "description": "SSO unique identifier (SAML nameid or OIDC sub claim) - required for SSO login",
      "type": "string"
    }
  },
  "required": [
    "schemas",
    "userName",
    "emails",
    "externalId"
  ]
}
```

**Responses:**

- **201**: SCIM User

### GET /api/organizations/{name}/scim-provisioning/v2/Users/{userId}

**Get a SCIM provisioning user**

Retrieves a SCIM user by their ID for non-managed organizations.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| userId | path | string | Yes |  |

**Responses:**

- **200**: SCIM User

### PATCH /api/organizations/{name}/scim-provisioning/v2/Users/{userId}

**Update an attribute of a SCIM provisioning user**

Modify individual attributes for non-managed organizations. Only the `active` field can be modified. User profile fields are not editable via SCIM.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| userId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schemas": {
      "examples": [
        [
          "urn:ietf:params:scim:api:messages:2.0:PatchOp"
        ]
      ],
      "minItems": 1,
      "type": "array",
      "items": {
        "const": "urn:ietf:params:scim:api:messages:2.0:PatchOp"
      }
    },
    "Operations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "op": {
            "description": "`remove` operation is not supported for non-managed organizations",
            "enum": [
              "add",
              "remove",
              "replace"
            ]
          },
          "path": {
            "enum": [
              "active",
              "externalId",
              "userName",
              "emails[type eq \"work\"].value",
              "name.givenName",
              "name.familyName"
            ]
          },
          "value": {}
        },
        "required": [
          "op",
          "value"
        ]
      }
    }
  },
  "required": [
    "schemas",
    "Operations"
  ]
}
```

**Responses:**

- **200**: SCIM User

### PUT /api/organizations/{name}/scim-provisioning/v2/Users/{userId}

**Update a SCIM provisioning user**

Updates a provisioned user's invitation for non-managed organizations. User profile fields are not editable via SCIM for non-managed organizations.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| userId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schemas": {
      "examples": [
        [
          "urn:ietf:params:scim:schemas:core:2.0:User"
        ]
      ],
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "active": {
      "default": true,
      "type": "boolean"
    },
    "externalId": {
      "type": "string"
    }
  },
  "required": [
    "schemas",
    "externalId"
  ]
}
```

**Responses:**

- **200**: SCIM User
- **409**: User already exists

### DELETE /api/organizations/{name}/scim-provisioning/v2/Users/{userId}

**Delete a SCIM provisioning user**

Removes a user from the organization and deletes any pending invitations for non-managed organizations.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| userId | path | string | Yes |  |

**Responses:**

- **204**: User removed from organization
- **404**: User not found or not provisioned

### GET /api/organizations/{name}/scim-provisioning/v2/Groups

**List SCIM groups**

Get a list of SCIM groups. Retrieves a paginated list of all organization groups. If you provide the filter parameter, the resources for all matching groups are returned.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| startIndex | query | number | No |  |
| count | query | number | No |  |
| filter | query | string | No |  |
| excludedAttributes | query | string | No |  |

**Responses:**

- **200**: SCIM Group List

### POST /api/organizations/{name}/scim-provisioning/v2/Groups

**Create a SCIM group**

Creates a new group in the organization. The group name must be unique within the organization.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "displayName": {
      "type": "string"
    },
    "externalId": {
      "type": "string"
    },
    "members": {
      "description": "Array of SCIM user ids",
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string",
            "minLength": 24,
            "maxLength": 24,
            "pattern": "^[0-9a-fA-F]{24}$"
          }
        },
        "required": [
          "value"
        ]
      }
    }
  },
  "required": [
    "displayName",
    "members"
  ]
}
```

**Responses:**

- **201**: SCIM Group
- **409**: Group already exists

### GET /api/organizations/{name}/scim-provisioning/v2/Groups/{groupId}

**Get a SCIM group**

Retrieves a group by its ID. If you provide the `excludedAttributes` parameter, the `members` attribute is not returned.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| groupId | path | string | Yes |  |
| excludedAttributes | query | string | No |  |

**Responses:**

- **200**: SCIM Group

### PUT /api/organizations/{name}/scim-provisioning/v2/Groups/{groupId}

**Update a SCIM group**

Updates a group by its ID. The group name must be unique within the organization.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| groupId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schemas": {
      "examples": [
        [
          "urn:ietf:params:scim:schemas:core:2.0:Group"
        ]
      ],
      "minItems": 1,
      "type": "array",
      "items": {
        "const": "urn:ietf:params:scim:schemas:core:2.0:Group"
      }
    },
    "displayName": {
      "type": "string"
    },
    "externalId": {
      "type": "string"
    },
    "members": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string",
            "minLength": 24,
            "maxLength": 24,
            "pattern": "^[0-9a-fA-F]{24}$"
          }
        },
        "required": [
          "value"
        ]
      }
    }
  },
  "required": [
    "schemas",
    "displayName",
    "members"
  ]
}
```

**Responses:**

- **200**: SCIM Group

### PATCH /api/organizations/{name}/scim-provisioning/v2/Groups/{groupId}

**Update SCIM group**

Update attributes of a SCIM group. Updates individual attributes using Operations format. Just provide the changes you want to make using add, remove (only `members` is supported), or replace operations.

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| groupId | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "schemas": {
      "examples": [
        [
          "urn:ietf:params:scim:api:messages:2.0:PatchOp"
        ]
      ],
      "minItems": 1,
      "type": "array",
      "items": {
        "const": "urn:ietf:params:scim:api:messages:2.0:PatchOp"
      }
    },
    "Operations": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "op": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "value": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "value": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "value"
                  ]
                }
              }
            },
            "required": [
              "op",
              "path"
            ]
          },
          {
            "type": "object",
            "properties": {
              "op": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "value": {}
            },
            "required": [
              "op",
              "value"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "schemas",
    "Operations"
  ]
}
```

**Responses:**

- **200**: SCIM Group

### DELETE /api/organizations/{name}/scim-provisioning/v2/Groups/{groupId}

**Delete a SCIM group**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| name | path | string | Yes |  |
| groupId | path | string | Yes |  |

**Responses:**

- **204**: SCIM Group deleted

## Agentic Provisioning

The following endpoints are for use with Agentic Provisioning Protocol.

### GET /api/agentic/provisioning/health

**Get Agentic Provisioning health**

### GET /api/agentic/provisioning/services

**Get Agentic Provisioning services**

**Responses:**

- **200**: List of available Agentic Provisioning services

### POST /api/agentic/provisioning/account_requests

**Create an Agentic Provisioning account request**

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1
    },
    "object": {
      "const": "account_request"
    },
    "name": {
      "type": "string",
      "minLength": 1
    },
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "scopes": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "phone": {
      "type": "string",
      "minLength": 1
    },
    "country": {
      "type": "string",
      "minLength": 1
    },
    "kyc": {
      "type": "object",
      "properties": {
        "verified_fields": {
          "type": "array",
          "items": {
            "enum": [
              "name",
              "email",
              "phone",
              "country"
            ]
          }
        }
      },
      "required": [
        "verified_fields"
      ]
    },
    "client_capabilities": {
      "type": "array",
      "items": {
        "enum": [
          "browser",
          "email",
          "sms"
        ]
      }
    },
    "configuration": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    },
    "confirmation_secret": {
      "type": "string",
      "minLength": 1
    },
    "expires_at": {
      "type": "string",
      "format": "date-time",
      "pattern": "^((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d+)?(Z)$"
    },
    "orchestrator": {
      "type": "object",
      "properties": {
        "type": {
          "const": "stripe"
        },
        "stripe": {
          "type": "object",
          "properties": {
            "organization": {
              "type": "string",
              "minLength": 1
            },
            "account": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "account"
          ]
        }
      },
      "required": [
        "type",
        "stripe"
      ]
    }
  },
  "required": [
    "id",
    "object",
    "email",
    "scopes",
    "client_capabilities",
    "confirmation_secret",
    "expires_at",
    "orchestrator"
  ]
}
```

**Responses:**

- **200**: Account request result
- **400**: Account request error

### POST /api/agentic/provisioning/resources

**Provision a resource**

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "service_id": {
          "const": "platform"
        }
      },
      "required": [
        "service_id"
      ]
    },
    {
      "type": "object",
      "properties": {
        "service_id": {
          "const": "bucket"
        },
        "configuration": {
          "type": "object",
          "properties": {
            "name": {
              "description": "The name of the repository (defaults to a random name if not provided)",
              "default": "FsBHuUal",
              "type": "string",
              "minLength": 1
            },
            "visibility": {
              "default": "private",
              "description": "The visibility of the repository (defaults to private)",
              "enum": [
                "public",
                "private"
              ]
            }
          }
        }
      },
      "required": [
        "service_id",
        "configuration"
      ]
    },
    {
      "type": "object",
      "properties": {
        "service_id": {
          "const": "free"
        },
        "configuration": {
          "type": "object",
          "properties": {
            "rechargeAmountUsd": {
              "description": "Optional pay-as-you-go auto top-up ceiling, in USD. If set, usage above the plan's included quota is billed via the shared payment token (minimum $15). If omitted, the plan's included quota is a hard cap.",
              "type": "number",
              "minimum": 15
            }
          }
        },
        "payment_credentials": {
          "type": "object",
          "properties": {
            "type": {
              "const": "stripe_payment_token"
            },
            "stripe_payment_token": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "type",
            "stripe_payment_token"
          ]
        }
      },
      "required": [
        "service_id"
      ]
    },
    {
      "type": "object",
      "properties": {
        "service_id": {
          "const": "pro"
        },
        "configuration": {
          "type": "object",
          "properties": {
            "rechargeAmountUsd": {
              "description": "Optional pay-as-you-go auto top-up ceiling, in USD. If set, usage above the plan's included quota is billed via the shared payment token (minimum $15). If omitted, the plan's included quota is a hard cap.",
              "type": "number",
              "minimum": 15
            }
          }
        },
        "payment_credentials": {
          "type": "object",
          "properties": {
            "type": {
              "const": "stripe_payment_token"
            },
            "stripe_payment_token": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "type",
            "stripe_payment_token"
          ]
        }
      },
      "required": [
        "service_id"
      ]
    }
  ]
}
```

**Responses:**

- **200**: Provisioned resource
- **400**: Resource provisioning error

### GET /api/agentic/provisioning/resources/{id}

**Get a resource by ID**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| id | path | string | Yes |  |

**Responses:**

- **200**: Resource status
- **400**: Resource error

### POST /api/agentic/provisioning/resources/{id}/update_service

**Update a resource's service (e.g. plan upgrade)**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| id | path | string | Yes |  |

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "service_id": {
      "type": "string",
      "minLength": 1
    },
    "configuration": {
      "type": "object",
      "properties": {
        "rechargeAmountUsd": {
          "description": "Set a number (USD, minimum $15) to enable or update pay-as-you-go auto top-up; pass null to disable; omit to leave it unchanged.",
          "anyOf": [
            {
              "type": "number",
              "minimum": 15
            },
            {
              "type": "null"
            }
          ]
        }
      }
    },
    "payment_credentials": {
      "type": "object",
      "properties": {
        "type": {
          "const": "stripe_payment_token"
        },
        "stripe_payment_token": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "type"
      ]
    }
  }
}
```

**Responses:**

- **200**: Service update result
- **400**: Service update error

### POST /api/agentic/provisioning/resources/{id}/remove

**Remove / de-provision a resource**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| id | path | string | Yes |  |

**Responses:**

- **200**: Resource removal result
- **400**: Resource removal error

### POST /api/agentic/provisioning/resources/{id}/rotate_credentials

**Rotate the credentials for a resource**

**Parameters:**

| Name | In | Type | Required | Description |
|------|----|------|----------|-------------|
| id | path | string | Yes |  |

**Responses:**

- **200**: Rotated credentials
- **400**: Credential rotation error
- **404**: Resource not found
- **409**: Token was modified concurrently

### POST /api/agentic/provisioning/deep_links

**Create a self-authenticated deep link to the user's billing dashboard**

**Request Body:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "purpose": {
      "const": "dashboard"
    }
  },
  "required": [
    "purpose"
  ]
}
```

**Responses:**

- **200**: Deep link URL
- **400**: Deep link error
