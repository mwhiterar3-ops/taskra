//! Cross-language vectors. The TypeScript SDK asserts the same literals in
//! packages/sdk/src/pda.test.ts and packages/sdk/src/errors.ts, so the program
//! and the SDK cannot drift apart on address derivation or error codes.

use anchor_lang::{error::ErrorCode, prelude::Pubkey, solana_program::bpf_loader_upgradeable};
use anchor_spl::associated_token::get_associated_token_address;
use taskra::{
    constants::{ESCROW_SEED, PLATFORM_SEED, TASK_SEED},
    error::TaskraError,
};

fn address(text: &str) -> Pubkey {
    text.parse().unwrap()
}

#[test]
fn pda_vectors_match_the_sdk() {
    let client = Pubkey::new_from_array([1; 32]);
    let mint = Pubkey::new_from_array([2; 32]);
    // UUID 00112233-4455-6677-8899-aabbccddeeff in network byte order.
    let task_id: [u8; 16] = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff,
    ];
    assert_eq!(
        client,
        address("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi")
    );
    assert_eq!(mint, address("8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"));

    let (platform, platform_bump) = Pubkey::find_program_address(&[PLATFORM_SEED], &taskra::ID);
    assert_eq!(
        platform,
        address("BEbbxHCLBAZkjN4rn7CEEzQBRqL2GVajCzevARCmBkBK")
    );
    assert_eq!(platform_bump, 255);

    let (task, task_bump) =
        Pubkey::find_program_address(&[TASK_SEED, client.as_ref(), &task_id], &taskra::ID);
    assert_eq!(
        task,
        address("FdjWk7omixsmdTin2SvbnN7m9rVDDkBFeTQwy2ViMBPe")
    );
    assert_eq!(task_bump, 254);

    let (escrow, escrow_bump) =
        Pubkey::find_program_address(&[ESCROW_SEED, task.as_ref()], &taskra::ID);
    assert_eq!(
        escrow,
        address("CqkX32QzDm5exyR7CHqSxc5kKxFL2HKq3Md8RyRpjJyF")
    );
    assert_eq!(escrow_bump, 255);

    let (program_data, _) =
        Pubkey::find_program_address(&[taskra::ID.as_ref()], &bpf_loader_upgradeable::ID);
    assert_eq!(
        program_data,
        address("DwEhJnFHWMFbaGoodUDWFG23fPDVjknHLHH3wxrNZmvM")
    );

    assert_eq!(
        get_associated_token_address(&client, &mint),
        address("CsYkfSfTUTWwnoeRkGchtai5kkYz2SC33kKJwA99wVr3")
    );
}

#[test]
fn error_codes_match_the_sdk() {
    // First and last program errors: the SDK's table is checked against the IDL
    // for everything in between.
    assert_eq!(u32::from(TaskraError::InvalidFeeBps), 6000);
    assert_eq!(u32::from(TaskraError::InvalidState), 6008);
    assert_eq!(u32::from(TaskraError::Unauthorized), 6009);
    assert_eq!(u32::from(TaskraError::MathOverflow), 6023);

    // The Anchor framework codes the SDK names (ANCHOR_ERROR_CODES).
    for (code, expected) in [
        (ErrorCode::ConstraintMut, 2000),
        (ErrorCode::ConstraintSigner, 2002),
        (ErrorCode::ConstraintSeeds, 2006),
        (ErrorCode::ConstraintAssociated, 2009),
        (ErrorCode::ConstraintAddress, 2012),
        (ErrorCode::ConstraintTokenMint, 2014),
        (ErrorCode::ConstraintTokenOwner, 2015),
        (ErrorCode::ConstraintDuplicateMutableAccount, 2040),
        (ErrorCode::AccountDiscriminatorMismatch, 3002),
        (ErrorCode::AccountNotEnoughKeys, 3005),
        (ErrorCode::AccountOwnedByWrongProgram, 3007),
        (ErrorCode::InvalidProgramId, 3008),
        (ErrorCode::AccountNotInitialized, 3012),
        (ErrorCode::DeclaredProgramIdMismatch, 4100),
    ] {
        assert_eq!(u32::from(code), expected, "{code:?}");
    }
}
