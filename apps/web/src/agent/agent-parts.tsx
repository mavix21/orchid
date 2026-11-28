import { useState } from "react";
import { CheckIcon } from "lucide-react";
import * as Match from "effect/Match";
import { useNavigate } from "@tanstack/react-router";
import type { ChatAddToolOutputFunction } from "ai";
import { Button } from "@workspace/ui/components/button";
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldTitle,
} from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@workspace/ui/components/item";
import { Switch } from "@workspace/ui/components/switch";

import { FullValue } from "@/links/recovery";
import { formattingLocale } from "@/locale/format";
import { m } from "@/paraglide/messages";
import type {
  AgentMessage,
  AgentPart,
  AssetView,
  RiskFlag,
} from "./agent-message";

type Answer = ChatAddToolOutputFunction<AgentMessage>;

const riskText: Readonly<Record<RiskFlag, () => string>> = {
  first_payment: m.agent_risk_first_payment,
  lookalike_username: m.agent_risk_lookalike_username,
  external_address: m.agent_risk_external_address,
  memo_required: m.agent_risk_memo_required,
  muxed_address: m.agent_risk_muxed_address,
  large_share: m.agent_risk_large_share,
};

function Chosen({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 self-start text-body text-muted-foreground">
      <CheckIcon aria-hidden className="size-4" />
      {children}
    </p>
  );
}

interface ProposalActions {
  readonly onReview: () => void;
  readonly onChange: () => void;
  readonly onCancel: () => void;
}

function Proposal({
  title,
  risks,
  actions,
  children,
}: {
  title: string;
  risks: ReadonlyArray<RiskFlag>;
  actions: ProposalActions;
  children?: React.ReactNode;
}) {
  return (
    <Item variant="outline" data-testid="agent-proposal">
      <ItemContent>
        <ItemTitle className="break-all">{title}</ItemTitle>
        {children}
        {risks.map((risk) => (
          <p key={risk} className="text-body text-destructive">
            {riskText[risk]()}
          </p>
        ))}
        <ItemDescription>{m.agent_link_proposal_note()}</ItemDescription>
      </ItemContent>
      <ItemFooter className="flex-wrap">
        <Button size="sm" onClick={actions.onReview} data-testid="agent-review">
          {m.agent_review_approve()}
        </Button>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={actions.onChange}
            data-testid="agent-change"
          >
            {m.agent_change()}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={actions.onCancel}
            data-testid="agent-cancel"
          >
            {m.agent_cancel()}
          </Button>
        </div>
      </ItemFooter>
    </Item>
  );
}

function Detail({ label, children }: { label: string; children: string }) {
  return (
    <p className="flex flex-col text-caption text-muted-foreground">
      <span>{label}</span>
      <FullValue>{children}</FullValue>
    </p>
  );
}

function AssetIssuer({ asset }: { asset: AssetView }) {
  const issuer = asset.id.split(":").at(1);

  return issuer === undefined ? (
    <ItemDescription>
      {m.agent_native_asset({ asset: asset.code })}
    </ItemDescription>
  ) : (
    <Detail label={m.agent_issuer({ asset: asset.code })}>{issuer}</Detail>
  );
}

function LinkProposal({
  id,
  asset,
  amount,
  risks,
  onReview,
  onChange,
  onCancel,
}: {
  id: string;
  asset: AssetView;
  amount: string;
  risks: ReadonlyArray<RiskFlag>;
  onReview: (saveOnDevice: boolean) => void;
  onChange: () => void;
  onCancel: () => void;
}) {
  const [saveOnDevice, setSaveOnDevice] = useState(true);

  return (
    <Proposal
      title={m.agent_link_proposal({ amount, asset: asset.code })}
      risks={risks}
      actions={{ onReview: () => onReview(saveOnDevice), onChange, onCancel }}
    >
      <AssetIssuer asset={asset} />
      <FieldLabel htmlFor={`save-${id}`}>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>{m.link_save()}</FieldTitle>
          </FieldContent>
          <Switch
            id={`save-${id}`}
            checked={saveOnDevice}
            onCheckedChange={setSaveOnDevice}
            data-testid="agent-save-link"
          />
        </Field>
      </FieldLabel>
    </Proposal>
  );
}

const createdOn = (createdAt: string) =>
  new Date(createdAt).toLocaleString(formattingLocale(), {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

function ValueQuestion({
  question,
  onSubmit,
}: {
  question: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();

        if (value.trim() !== "") onSubmit(value.trim());
      }}
    >
      <p>{question}</p>
      <div className="flex gap-2">
        <Input
          value={value}
          aria-label={m.agent_answer_placeholder()}
          placeholder={m.agent_answer_placeholder()}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="sm">
          {m.agent_answer_send()}
        </Button>
      </div>
    </form>
  );
}

function Choices({
  question,
  options,
  onChoose,
}: {
  question: string;
  options: ReadonlyArray<string>;
  onChoose: (option: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p>{question}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option}
            size="sm"
            variant="secondary"
            onClick={() => onChoose(option)}
          >
            {option}
          </Button>
        ))}
      </div>
    </div>
  );
}

type ProposedRecipient = Extract<
  AgentPart,
  { type: "tool-propose_transfer"; state: "output-available" }
>["output"]["recipient"];

const recipientLabel = (recipient: ProposedRecipient) =>
  Match.value(recipient).pipe(
    Match.tag("Wallet", ({ username }) => `@${username}`),
    Match.tag(
      "External",
      ({ exchange }) => exchange ?? m.agent_external_recipient(),
    ),
    Match.exhaustive,
  );

export function AgentToolPart({
  part,
  assets,
  answer,
  onChange,
  onCancel,
}: {
  part: AgentPart;
  assets: ReadonlyArray<AssetView>;
  answer: Answer;
  onChange: (toolCallId: string) => void;
  onCancel: (toolCallId: string) => void;
}) {
  const navigate = useNavigate();

  return Match.value(part).pipe(
    Match.withReturnType<React.ReactNode>(),
    Match.when(
      { type: "tool-choose_asset", state: "output-available" },
      ({ output }) => (
        <Chosen>{m.agent_asset_chosen({ asset: output.asset.code })}</Chosen>
      ),
    ),
    Match.when(
      { type: "tool-choose_asset", state: "input-available" },
      ({ toolCallId }) => (
        <Choices
          question={m.agent_choose_asset()}
          options={assets.map((asset) => asset.code)}
          onChoose={(code) => {
            const asset = assets.find((candidate) => candidate.code === code);

            if (asset !== undefined)
              void answer({
                tool: "choose_asset",
                toolCallId,
                output: { asset },
              });
          }}
        />
      ),
    ),
    Match.when(
      { type: "tool-choose_one", state: "output-available" },
      ({ output }) => (
        <Chosen>{m.agent_answered({ value: output.choice })}</Chosen>
      ),
    ),
    Match.when(
      { type: "tool-choose_one", state: "input-available" },
      ({ toolCallId, input }) => (
        <Choices
          question={input.question}
          options={input.options}
          onChoose={(choice) =>
            void answer({ tool: "choose_one", toolCallId, output: { choice } })
          }
        />
      ),
    ),
    Match.when(
      { type: "tool-ask_value", state: "output-available" },
      ({ output }) => (
        <Chosen>{m.agent_answered({ value: output.value })}</Chosen>
      ),
    ),
    Match.when(
      { type: "tool-ask_value", state: "input-available" },
      ({ toolCallId, input }) => (
        <ValueQuestion
          question={input.question}
          onSubmit={(value) =>
            void answer({ tool: "ask_value", toolCallId, output: { value } })
          }
        />
      ),
    ),
    Match.when(
      { type: "tool-propose_transfer", state: "output-available" },
      ({ toolCallId, output }) => (
        <Proposal
          title={m.agent_transfer_proposal({
            amount: output.amount,
            asset: output.asset.code,
            recipient: recipientLabel(output.recipient),
          })}
          risks={output.risks}
          actions={{
            onChange: () => onChange(toolCallId),
            onCancel: () => onCancel(toolCallId),
            onReview: () =>
              void navigate({
                to: "/send/$asset",
                params: { asset: output.asset.id },
                search: Match.value(output.recipient).pipe(
                  Match.withReturnType<{
                    to: "username" | "address";
                    recipient: string;
                  }>(),
                  Match.tag("Wallet", ({ username }) => ({
                    to: "username",
                    recipient: username,
                  })),
                  Match.tag("External", ({ address }) => ({
                    to: "address",
                    recipient: address,
                  })),
                  Match.exhaustive,
                  (destination) => ({
                    ...destination,
                    amount: output.amount,
                    memo: output.memo?.value,
                  }),
                ),
              }),
          }}
        >
          <Detail label={m.agent_destination_address()}>
            {output.recipient.address}
          </Detail>
          <AssetIssuer asset={output.asset} />
          {output.memo === undefined ? null : (
            <ItemDescription>
              {m.agent_memo({ memo: output.memo.value })}
            </ItemDescription>
          )}
        </Proposal>
      ),
    ),
    Match.when(
      { type: "tool-propose_payment_link", state: "output-available" },
      ({ toolCallId, output }) => (
        <LinkProposal
          id={toolCallId}
          asset={output.asset}
          amount={output.amount}
          risks={output.risks}
          onChange={() => onChange(toolCallId)}
          onCancel={() => onCancel(toolCallId)}
          onReview={(saveOnDevice) =>
            void navigate({
              to: "/send/$asset",
              params: { asset: output.asset.id },
              search: { to: "link", amount: output.amount, save: saveOnDevice },
            })
          }
        />
      ),
    ),
    Match.when(
      { type: "tool-propose_take_back", state: "output-available" },
      ({ toolCallId, output }) => (
        <Proposal
          title={m.agent_take_back_proposal({
            amount: output.amount,
            asset: output.asset.code,
          })}
          risks={[]}
          actions={{
            onChange: () => onChange(toolCallId),
            onCancel: () => onCancel(toolCallId),
            onReview: () =>
              void navigate({ to: "/links", search: { recover: output.link } }),
          }}
        >
          <ItemDescription>
            {m.agent_link_created({ date: createdOn(output.createdAt) })}
          </ItemDescription>
        </Proposal>
      ),
    ),
    Match.when({ state: "output-error" }, () => (
      <p>{m.agent_proposal_refused()}</p>
    )),
    Match.orElse(() => null),
  );
}
