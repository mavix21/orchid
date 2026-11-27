import { createServerFn } from "@tanstack/react-start";
import {
  AccountAddress,
  CancelPaymentRequestStep,
  CreatePaymentRequestStep,
  NewPaymentRequest,
  OpenPaymentRequestsStep,
  PaymentRequestId,
  type PaymentRequestPort,
  PaymentRequestStep,
} from "@workspace/wallet";
import { PaymentRequests } from "@workspace/wallet/server";
import * as Schema from "effect/Schema";
import {
  answerPaymentRequests,
  publicly,
  speakingFor,
} from "../server/wallet.server";
import { accepted, reach } from "@/wallet/reach";

const CreateCall = Schema.Struct({
  address: AccountAddress,
  request: NewPaymentRequest,
});

const ReadCall = Schema.Struct({ id: PaymentRequestId });

const OpenCall = Schema.Struct({ address: AccountAddress });

const CancelCall = Schema.Struct({
  address: AccountAddress,
  id: PaymentRequestId,
});

const createRequestFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof CreateCall.Encoded>())
  .handler(({ data }) =>
    answerPaymentRequests(
      CreateCall,
      data,
      CreatePaymentRequestStep,
      (decoded) =>
        speakingFor(
          decoded.address,
          PaymentRequests.use((requests) =>
            requests.create(decoded.address, decoded.request),
          ),
        ),
    ),
  );

const readRequestFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof ReadCall.Encoded>())
  .handler(({ data }) =>
    answerPaymentRequests(ReadCall, data, PaymentRequestStep, (decoded) =>
      publicly(PaymentRequests.use((requests) => requests.read(decoded.id))),
    ),
  );

const openRequestsFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof OpenCall.Encoded>())
  .handler(({ data }) =>
    answerPaymentRequests(OpenCall, data, OpenPaymentRequestsStep, (decoded) =>
      speakingFor(
        decoded.address,
        PaymentRequests.use((requests) => requests.open(decoded.address)),
      ),
    ),
  );

const cancelRequestFn = createServerFn({ method: "POST" })
  .validator(accepted<typeof CancelCall.Encoded>())
  .handler(({ data }) =>
    answerPaymentRequests(
      CancelCall,
      data,
      CancelPaymentRequestStep,
      (decoded) =>
        speakingFor(
          decoded.address,
          PaymentRequests.use((requests) =>
            requests.cancel(decoded.address, decoded.id),
          ),
        ),
    ),
  );

export const paymentRequestPort: PaymentRequestPort = {
  create: (address, request) =>
    reach(
      CreatePaymentRequestStep,
      CreateCall,
      { address, request },
      createRequestFn,
    ),
  read: (id) => reach(PaymentRequestStep, ReadCall, { id }, readRequestFn),
  open: (address) =>
    reach(OpenPaymentRequestsStep, OpenCall, { address }, openRequestsFn),
  cancel: (address, id) =>
    reach(
      CancelPaymentRequestStep,
      CancelCall,
      { address, id },
      cancelRequestFn,
    ),
};
