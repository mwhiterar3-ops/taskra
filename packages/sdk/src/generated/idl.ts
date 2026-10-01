// Generated from target/idl/taskra.json by scripts/sync-idl.mjs. Do not edit by hand.
export const IDL = {
  address: 'CCgMR2BZ7Hr4SiMRPYsY6yzZsGgddygjH3eF8A939mkZ',
  metadata: {
    name: 'taskra',
    version: '0.1.0',
    spec: '0.1.0',
    description: 'Taskra task escrow and settlement program',
  },
  instructions: [
    {
      name: 'accept_task',
      docs: ['T3'],
      discriminator: [222, 196, 79, 165, 120, 30, 38, 120],
      accounts: [
        {
          name: 'developer',
          signer: true,
        },
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
      ],
      args: [],
    },
    {
      name: 'approve_task',
      docs: ['T9'],
      discriminator: [81, 171, 95, 228, 10, 231, 167, 225],
      accounts: [
        {
          name: 'client',
          writable: true,
          signer: true,
        },
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
        {
          name: 'usdc_mint',
        },
        {
          name: 'escrow',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [101, 115, 99, 114, 111, 119],
              },
              {
                kind: 'account',
                path: 'task',
              },
            ],
          },
        },
        {
          name: 'developer_token',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'account',
                path: 'task.developer',
                account: 'Task',
              },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              {
                kind: 'account',
                path: 'usdc_mint',
              },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'treasury',
          writable: true,
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
      ],
      args: [
        {
          name: 'evidence_hash',
          type: {
            array: ['u8', 32],
          },
        },
      ],
    },
    {
      name: 'cancel_task',
      docs: ['T2'],
      discriminator: [69, 228, 134, 187, 134, 105, 238, 48],
      accounts: [
        {
          name: 'client',
          writable: true,
          signer: true,
        },
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
        {
          name: 'usdc_mint',
        },
        {
          name: 'escrow',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [101, 115, 99, 114, 111, 119],
              },
              {
                kind: 'account',
                path: 'task',
              },
            ],
          },
        },
        {
          name: 'client_token',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'account',
                path: 'client',
              },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              {
                kind: 'account',
                path: 'usdc_mint',
              },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
      ],
      args: [],
    },
    {
      name: 'create_and_fund_task',
      docs: ['T1'],
      discriminator: [0, 142, 234, 27, 129, 198, 51, 254],
      accounts: [
        {
          name: 'client',
          writable: true,
          signer: true,
        },
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'usdc_mint',
        },
        {
          name: 'client_token',
          writable: true,
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'client',
              },
              {
                kind: 'arg',
                path: 'task_id',
              },
            ],
          },
        },
        {
          name: 'escrow',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [101, 115, 99, 114, 111, 119],
              },
              {
                kind: 'account',
                path: 'task',
              },
            ],
          },
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
        {
          name: 'system_program',
          address: '11111111111111111111111111111111',
        },
      ],
      args: [
        {
          name: 'task_id',
          type: {
            array: ['u8', 16],
          },
        },
        {
          name: 'amount',
          type: 'u64',
        },
        {
          name: 'work_duration',
          type: 'i64',
        },
        {
          name: 'terms_hash',
          type: {
            array: ['u8', 32],
          },
        },
      ],
    },
    {
      name: 'expire_dispute',
      docs: ['T15, T16'],
      discriminator: [241, 116, 178, 182, 234, 173, 61, 120],
      accounts: [
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
        {
          name: 'usdc_mint',
        },
        {
          name: 'escrow',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [101, 115, 99, 114, 111, 119],
              },
              {
                kind: 'account',
                path: 'task',
              },
            ],
          },
        },
        {
          name: 'client',
          writable: true,
        },
        {
          name: 'client_token',
          writable: true,
          optional: true,
          pda: {
            seeds: [
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              {
                kind: 'account',
                path: 'usdc_mint',
              },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'developer_token',
          writable: true,
          optional: true,
          pda: {
            seeds: [
              {
                kind: 'account',
                path: 'task.developer',
                account: 'Task',
              },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              {
                kind: 'account',
                path: 'usdc_mint',
              },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'treasury',
          writable: true,
          optional: true,
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
      ],
      args: [],
    },
    {
      name: 'expire_review',
      docs: ['T11'],
      discriminator: [99, 163, 211, 46, 73, 192, 241, 105],
      accounts: [
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
        {
          name: 'usdc_mint',
        },
        {
          name: 'escrow',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [101, 115, 99, 114, 111, 119],
              },
              {
                kind: 'account',
                path: 'task',
              },
            ],
          },
        },
        {
          name: 'client',
          writable: true,
        },
        {
          name: 'developer_token',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'account',
                path: 'task.developer',
                account: 'Task',
              },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              {
                kind: 'account',
                path: 'usdc_mint',
              },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'treasury',
          writable: true,
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
      ],
      args: [],
    },
    {
      name: 'initialize_platform',
      discriminator: [119, 201, 101, 45, 75, 122, 89, 3],
      accounts: [
        {
          name: 'upgrade_authority',
          docs: ["Must be the program's upgrade authority, so initialization cannot be front-run."],
          writable: true,
          signer: true,
        },
        {
          name: 'platform',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'usdc_mint',
        },
        {
          name: 'treasury',
        },
        {
          name: 'program',
          address: 'CCgMR2BZ7Hr4SiMRPYsY6yzZsGgddygjH3eF8A939mkZ',
        },
        {
          name: 'program_data',
        },
        {
          name: 'system_program',
          address: '11111111111111111111111111111111',
        },
      ],
      args: [
        {
          name: 'args',
          type: {
            defined: {
              name: 'InitializePlatformArgs',
            },
          },
        },
      ],
    },
    {
      name: 'open_developer_dispute',
      docs: ['T12'],
      discriminator: [15, 49, 196, 114, 78, 231, 231, 11],
      accounts: [
        {
          name: 'developer',
          signer: true,
        },
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
      ],
      args: [],
    },
    {
      name: 'record_attestation',
      docs: ['T6'],
      discriminator: [148, 43, 225, 77, 15, 134, 217, 54],
      accounts: [
        {
          name: 'attester',
          signer: true,
        },
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
      ],
      args: [
        {
          name: 'evidence_hash',
          type: {
            array: ['u8', 32],
          },
        },
        {
          name: 'submission_nonce',
          type: 'u64',
        },
      ],
    },
    {
      name: 'refund_expired',
      docs: ['T7, T8'],
      discriminator: [118, 153, 164, 244, 40, 128, 242, 250],
      accounts: [
        {
          name: 'client',
          writable: true,
          signer: true,
        },
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
        {
          name: 'usdc_mint',
        },
        {
          name: 'escrow',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [101, 115, 99, 114, 111, 119],
              },
              {
                kind: 'account',
                path: 'task',
              },
            ],
          },
        },
        {
          name: 'client_token',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'account',
                path: 'client',
              },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              {
                kind: 'account',
                path: 'usdc_mint',
              },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
      ],
      args: [],
    },
    {
      name: 'reject_task',
      docs: ['T10'],
      discriminator: [152, 59, 207, 37, 222, 254, 28, 106],
      accounts: [
        {
          name: 'client',
          signer: true,
        },
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
      ],
      args: [
        {
          name: 'reason_hash',
          type: {
            array: ['u8', 32],
          },
        },
      ],
    },
    {
      name: 'resolve_dispute',
      docs: ['T13, T14'],
      discriminator: [231, 6, 202, 6, 96, 103, 12, 230],
      accounts: [
        {
          name: 'authority',
          signer: true,
        },
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
        {
          name: 'usdc_mint',
        },
        {
          name: 'escrow',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [101, 115, 99, 114, 111, 119],
              },
              {
                kind: 'account',
                path: 'task',
              },
            ],
          },
        },
        {
          name: 'client',
          writable: true,
        },
        {
          name: 'client_token',
          writable: true,
          optional: true,
          pda: {
            seeds: [
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              {
                kind: 'account',
                path: 'usdc_mint',
              },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'developer_token',
          writable: true,
          optional: true,
          pda: {
            seeds: [
              {
                kind: 'account',
                path: 'task.developer',
                account: 'Task',
              },
              {
                kind: 'const',
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              {
                kind: 'account',
                path: 'usdc_mint',
              },
            ],
            program: {
              kind: 'const',
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: 'treasury',
          writable: true,
          optional: true,
        },
        {
          name: 'token_program',
          address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
      ],
      args: [
        {
          name: 'resolution',
          type: {
            defined: {
              name: 'DisputeResolution',
            },
          },
        },
      ],
    },
    {
      name: 'rotate_keys',
      discriminator: [248, 193, 6, 139, 151, 141, 189, 50],
      accounts: [
        {
          name: 'authority',
          signer: true,
        },
        {
          name: 'platform',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'usdc_mint',
        },
        {
          name: 'new_treasury',
          docs: ['The treasury to use from now on. Pass the current one to keep it.'],
        },
        {
          name: 'program',
          address: 'CCgMR2BZ7Hr4SiMRPYsY6yzZsGgddygjH3eF8A939mkZ',
        },
        {
          name: 'program_data',
        },
      ],
      args: [
        {
          name: 'new_authority',
          type: 'pubkey',
        },
        {
          name: 'new_attester',
          type: 'pubkey',
        },
      ],
    },
    {
      name: 'submit_work',
      docs: ['T4, T5'],
      discriminator: [158, 80, 101, 51, 114, 130, 101, 253],
      accounts: [
        {
          name: 'developer',
          signer: true,
        },
        {
          name: 'platform',
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [112, 108, 97, 116, 102, 111, 114, 109],
              },
            ],
          },
        },
        {
          name: 'task',
          writable: true,
          pda: {
            seeds: [
              {
                kind: 'const',
                value: [116, 97, 115, 107],
              },
              {
                kind: 'account',
                path: 'task.client',
                account: 'Task',
              },
              {
                kind: 'account',
                path: 'task.task_id',
                account: 'Task',
              },
            ],
          },
        },
      ],
      args: [
        {
          name: 'evidence_hash',
          type: {
            array: ['u8', 32],
          },
        },
      ],
    },
  ],
  accounts: [
    {
      name: 'Platform',
      discriminator: [77, 92, 204, 58, 187, 98, 91, 12],
    },
    {
      name: 'Task',
      discriminator: [79, 34, 229, 55, 88, 90, 55, 84],
    },
  ],
  errors: [
    {
      code: 6000,
      name: 'InvalidFeeBps',
      msg: 'fee_bps must not exceed 10000',
    },
    {
      code: 6001,
      name: 'InvalidWindow',
      msg: 'Time windows must be positive',
    },
    {
      code: 6002,
      name: 'KeysNotSeparate',
      msg: 'Authority, attester, treasury owner and upgrade authority must be separate keys',
    },
    {
      code: 6003,
      name: 'InvalidUpgradeAuthority',
      msg: 'Signer is not the program upgrade authority',
    },
    {
      code: 6004,
      name: 'InvalidAmount',
      msg: 'Amount must be greater than zero',
    },
    {
      code: 6005,
      name: 'InvalidWorkDuration',
      msg: 'Work duration must be greater than zero',
    },
    {
      code: 6006,
      name: 'ZeroHash',
      msg: 'Hash must not be all zeros',
    },
    {
      code: 6007,
      name: 'EscrowBalanceMismatch',
      msg: 'Escrow balance does not equal the task amount after funding',
    },
    {
      code: 6008,
      name: 'InvalidState',
      msg: 'Task is not in a state that allows this instruction',
    },
    {
      code: 6009,
      name: 'Unauthorized',
      msg: 'Signer is not authorized for this instruction',
    },
    {
      code: 6010,
      name: 'ClientCannotAccept',
      msg: 'The task client cannot accept their own task',
    },
    {
      code: 6011,
      name: 'WorkDeadlinePassed',
      msg: 'The work deadline has passed',
    },
    {
      code: 6012,
      name: 'EvidenceMismatch',
      msg: 'Evidence hash does not match the current submission',
    },
    {
      code: 6013,
      name: 'NonceMismatch',
      msg: 'Submission nonce does not match the current submission',
    },
    {
      code: 6014,
      name: 'VerificationDeadlinePassed',
      msg: 'The verification deadline has passed',
    },
    {
      code: 6015,
      name: 'ReviewDeadlinePassed',
      msg: 'The review deadline has passed',
    },
    {
      code: 6016,
      name: 'ReviewDeadlineNotPassed',
      msg: 'The review deadline has not passed',
    },
    {
      code: 6017,
      name: 'DisputeWindowNotOpen',
      msg: 'The developer dispute window is not open yet',
    },
    {
      code: 6018,
      name: 'DisputeWindowClosed',
      msg: 'The developer dispute window has closed',
    },
    {
      code: 6019,
      name: 'RefundNotOpen',
      msg: 'The refund is not available yet',
    },
    {
      code: 6020,
      name: 'DisputeDeadlinePassed',
      msg: 'The dispute deadline has passed',
    },
    {
      code: 6021,
      name: 'DisputeDeadlineNotPassed',
      msg: 'The dispute deadline has not passed',
    },
    {
      code: 6022,
      name: 'MissingOutcomeAccount',
      msg: 'An account required for this outcome was not provided',
    },
    {
      code: 6023,
      name: 'MathOverflow',
      msg: 'Arithmetic overflow',
    },
  ],
  types: [
    {
      name: 'DisputeResolution',
      type: {
        kind: 'enum',
        variants: [
          {
            name: 'PayDeveloper',
          },
          {
            name: 'RefundClient',
          },
        ],
      },
    },
    {
      name: 'InitializePlatformArgs',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'authority',
            type: 'pubkey',
          },
          {
            name: 'attester',
            type: 'pubkey',
          },
          {
            name: 'fee_bps',
            type: 'u16',
          },
          {
            name: 'review_window',
            type: 'i64',
          },
          {
            name: 'verification_grace',
            type: 'i64',
          },
          {
            name: 'dispute_timeout',
            type: 'i64',
          },
        ],
      },
    },
    {
      name: 'Outcome',
      docs: ['How a task reached its terminal state.'],
      type: {
        kind: 'enum',
        variants: [
          {
            name: 'None',
          },
          {
            name: 'Cancelled',
          },
          {
            name: 'Approved',
          },
          {
            name: 'ReviewExpired',
          },
          {
            name: 'WorkDeadlineMissed',
          },
          {
            name: 'NeverVerified',
          },
          {
            name: 'DisputeResolvedForDeveloper',
          },
          {
            name: 'DisputeResolvedForClient',
          },
          {
            name: 'DisputeExpiredForDeveloper',
          },
          {
            name: 'DisputeExpiredForClient',
          },
        ],
      },
    },
    {
      name: 'Platform',
      docs: [
        'Singleton configuration. Only `authority`, `attester` and `treasury` can',
        'change after initialization (see `rotate_keys`).',
      ],
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'authority',
            docs: ['Resolves disputes and rotates keys.'],
            type: 'pubkey',
          },
          {
            name: 'attester',
            docs: ['May record attestations and nothing else.'],
            type: 'pubkey',
          },
          {
            name: 'treasury',
            docs: ['USDC token account that receives fees.'],
            type: 'pubkey',
          },
          {
            name: 'usdc_mint',
            type: 'pubkey',
          },
          {
            name: 'fee_bps',
            type: 'u16',
          },
          {
            name: 'review_window',
            type: 'i64',
          },
          {
            name: 'verification_grace',
            type: 'i64',
          },
          {
            name: 'dispute_timeout',
            type: 'i64',
          },
          {
            name: 'bump',
            type: 'u8',
          },
        ],
      },
    },
    {
      name: 'Task',
      docs: [
        'Economically relevant task state. Never closed: once terminal it is the',
        'permanent on-chain work record.',
      ],
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'task_id',
            type: {
              array: ['u8', 16],
            },
          },
          {
            name: 'client',
            type: 'pubkey',
          },
          {
            name: 'developer',
            docs: ['`Pubkey::default()` until accepted.'],
            type: 'pubkey',
          },
          {
            name: 'amount',
            docs: ['Escrowed amount in token base units.'],
            type: 'u64',
          },
          {
            name: 'fee_bps',
            docs: ['Fee rate copied from the platform at creation.'],
            type: 'u16',
          },
          {
            name: 'terms_hash',
            docs: ['SHA-256 of the canonical off-chain task terms.'],
            type: {
              array: ['u8', 32],
            },
          },
          {
            name: 'state',
            type: {
              defined: {
                name: 'TaskState',
              },
            },
          },
          {
            name: 'outcome',
            type: {
              defined: {
                name: 'Outcome',
              },
            },
          },
          {
            name: 'work_duration',
            type: 'i64',
          },
          {
            name: 'created_at',
            type: 'i64',
          },
          {
            name: 'accepted_at',
            type: 'i64',
          },
          {
            name: 'work_deadline',
            type: 'i64',
          },
          {
            name: 'verification_deadline',
            type: 'i64',
          },
          {
            name: 'submission_nonce',
            docs: ['Incremented by every submission; an attestation is valid for one nonce only.'],
            type: 'u64',
          },
          {
            name: 'evidence_hash',
            type: {
              array: ['u8', 32],
            },
          },
          {
            name: 'submitted_at',
            type: 'i64',
          },
          {
            name: 'dispute_open_at',
            type: 'i64',
          },
          {
            name: 'refund_open_at',
            type: 'i64',
          },
          {
            name: 'attested_nonce',
            type: 'u64',
          },
          {
            name: 'attested_hash',
            type: {
              array: ['u8', 32],
            },
          },
          {
            name: 'verified_at',
            docs: ['Zero while no attestation exists for the current submission.'],
            type: 'i64',
          },
          {
            name: 'review_deadline',
            type: 'i64',
          },
          {
            name: 'disputed_at',
            type: 'i64',
          },
          {
            name: 'dispute_deadline',
            type: 'i64',
          },
          {
            name: 'rejection_reason_hash',
            type: {
              array: ['u8', 32],
            },
          },
          {
            name: 'closed_at',
            type: 'i64',
          },
          {
            name: 'bump',
            type: 'u8',
          },
          {
            name: 'escrow_bump',
            type: 'u8',
          },
        ],
      },
    },
    {
      name: 'TaskState',
      type: {
        kind: 'enum',
        variants: [
          {
            name: 'Open',
          },
          {
            name: 'Accepted',
          },
          {
            name: 'Submitted',
          },
          {
            name: 'UnderReview',
          },
          {
            name: 'Disputed',
          },
          {
            name: 'Settled',
          },
          {
            name: 'Refunded',
          },
          {
            name: 'Cancelled',
          },
        ],
      },
    },
  ],
  constants: [
    {
      name: 'ESCROW_SEED',
      type: 'bytes',
      value: '[101, 115, 99, 114, 111, 119]',
    },
    {
      name: 'PLATFORM_SEED',
      type: 'bytes',
      value: '[112, 108, 97, 116, 102, 111, 114, 109]',
    },
    {
      name: 'TASK_SEED',
      type: 'bytes',
      value: '[116, 97, 115, 107]',
    },
  ],
} as const;
