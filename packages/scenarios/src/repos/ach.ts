import type { RepoOverlay } from '../types';

/** keybank/ACH00/ach-origination: NACHA entry validation and outbound batches. */
export const ACH_REPO = 'keybank/ACH00/ach-origination';

const PKG = 'src/main/java/com/keybank/ach';

export const ACH_PATHS = {
  routingClient: `${PKG}/client/RoutingDirectoryClient.java`,
  entryValidator: `${PKG}/validation/EntryValidator.java`,
  batchAssembly: `${PKG}/batch/BatchAssemblyService.java`,
} as const;

const ROUTING_CLIENT = `package com.keybank.ach.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** routing-directory-service (ABA) client. Only positive results are cached. */
@Component
public class RoutingDirectoryClient {

  public record RoutingValidation(
      String routingNumber, boolean valid, String reason, Institution institution) {
    public record Institution(String name, String city, String state) {}
  }

  private final RestClient http;

  public RoutingDirectoryClient(
      RestClient.Builder builder, @Value("\${ach.clients.aba-base-url}") String baseUrl) {
    this.http = builder.baseUrl(baseUrl).defaultHeader("X-Client-Id", "ach-origination").build();
  }

  @Cacheable(cacheNames = "routing-validation", unless = "!#result.valid()")
  public RoutingValidation validate(String routingNumber) {
    return http.get()
        .uri("/v1/routing-numbers/{rtn}/validate", routingNumber)
        .retrieve()
        .body(RoutingValidation.class);
  }
}
`;

export const ACH_ENTRY_VALIDATOR = `package com.keybank.ach.validation;

import com.keybank.ach.client.RoutingDirectoryClient;
import com.keybank.ach.client.RoutingDirectoryClient.RoutingValidation;
import java.math.BigDecimal;
import org.springframework.stereotype.Component;

/** NACHA entry detail checks before an entry joins an outbound batch. */
@Component
public class EntryValidator {

  private final RoutingDirectoryClient directory;

  public EntryValidator(RoutingDirectoryClient directory) {
    this.directory = directory;
  }

  public record EntryDetail(
      String traceNumber,
      String transactionCode,
      String rdfiRoutingNumber,
      String accountNumberMasked,
      BigDecimal amount,
      String individualName) {}

  public void validate(String batchId, EntryDetail entry) {
    if (entry.amount() == null || entry.amount().signum() <= 0) {
      throw new InvalidEntryException(batchId, entry, "INVALID_AMOUNT", "amount must be positive");
    }
    RoutingValidation rdfi = directory.validate(entry.rdfiRoutingNumber());
    if (!rdfi.valid()) {
      throw new InvalidEntryException(
          batchId,
          entry,
          "INVALID_RDFI_ROUTING",
          "RDFI routing number " + entry.rdfiRoutingNumber() + " failed ABA validation (" + rdfi.reason() + ")");
    }
  }

  public static class InvalidEntryException extends RuntimeException {
    private final String code;

    public InvalidEntryException(String batchId, EntryDetail entry, String code, String message) {
      super("Entry " + entry.traceNumber() + " in batch " + batchId + " rejected: " + message);
      this.code = code;
    }

    public String getCode() {
      return code;
    }
  }
}
`;

export const ACH_BATCH_ASSEMBLY = `package com.keybank.ach.batch;

import com.keybank.ach.validation.EntryValidator;
import com.keybank.ach.validation.EntryValidator.EntryDetail;
import com.keybank.ach.validation.EntryValidator.InvalidEntryException;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Service;

/** Builds outbound ACH batches from payment instructions published by payments-api. */
@Service
public class BatchAssemblyService {

  private static final Logger log = LoggerFactory.getLogger(BatchAssemblyService.class);

  /** More rejects than this and the whole batch is held for operations review. */
  private static final double HOLD_THRESHOLD = 0.05;

  private final EntryValidator validator;

  public BatchAssemblyService(EntryValidator validator) {
    this.validator = validator;
  }

  public record Instructions(String batchId, String companyId, List<EntryDetail> entries) {}

  public record BatchResult(String batchId, int accepted, List<String> rejected, boolean held) {}

  @KafkaListener(topics = "payments.ach.instructions", groupId = "ach-origination")
  public void onInstructions(List<Instructions> messages) {
    messages.forEach(this::assemble);
  }

  public BatchResult assemble(Instructions in) {
    List<EntryDetail> accepted = new ArrayList<>();
    List<String> rejected = new ArrayList<>();
    for (EntryDetail entry : in.entries()) {
      try {
        validator.validate(in.batchId(), entry);
        accepted.add(entry);
      } catch (InvalidEntryException ex) {
        log.error("ACH entry rejected code={} trace={} batch={}", ex.getCode(), entry.traceNumber(), in.batchId(), ex);
        rejected.add(entry.traceNumber());
      }
    }
    boolean held = !in.entries().isEmpty() && (double) rejected.size() / in.entries().size() > HOLD_THRESHOLD;
    if (held) {
      log.warn(
          "Batch {} held for operations review: {} of {} entries rejected (company={})",
          in.batchId(), rejected.size(), in.entries().size(), in.companyId());
    }
    return new BatchResult(in.batchId(), accepted.size(), rejected, held);
  }
}
`;

export const achOverlay: RepoOverlay = {
  complete: false,
  files: {
    [ACH_PATHS.routingClient]: ROUTING_CLIENT,
    [ACH_PATHS.entryValidator]: ACH_ENTRY_VALIDATOR,
    [ACH_PATHS.batchAssembly]: ACH_BATCH_ASSEMBLY,
  },
};
