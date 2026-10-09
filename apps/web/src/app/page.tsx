import Link from 'next/link';

export default function HomePage() {
  return (
    <>
      <h1>Taskra</h1>
      <p>
        A trust and settlement layer for verifiable technical work. A client escrows USDC on Solana,
        a developer proves the work with a merged GitHub pull request, and the settlement becomes
        part of the developer&apos;s record.
      </p>
      <section aria-labelledby="how-title">
        <h2 id="how-title">How a task works</h2>
        <ol>
          <li>The client creates a task and funds its escrow in one transaction.</li>
          <li>A developer accepts it and has until the work deadline to deliver.</li>
          <li>
            The developer submits a pull request. Taskra checks it against fixed rules and, if they
            hold, records the verification on-chain.
          </li>
          <li>
            The client approves, or the review window passes: the escrow pays the developer, less
            the 2.5% fee.
          </li>
          <li>
            If the client rejects, the task is disputed. If nothing is ever verified, the client is
            refunded. Escrow can never be locked forever.
          </li>
        </ol>
      </section>
      <p className="row">
        <Link href="/tasks">Browse tasks</Link>
        <Link href="/tasks/new">Create a task</Link>
      </p>
      <p className="muted">
        Taskra verifies evidence against predefined conditions. A merged pull request is evidence
        that work was accepted by a maintainer; it is not proof that the work is correct.
      </p>
    </>
  );
}
