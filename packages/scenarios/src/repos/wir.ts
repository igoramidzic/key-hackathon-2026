import type { RepoOverlay } from '../types';

/** keybank/WIR00/wire-transfer-service: Fedwire and SWIFT origination. */
export const WIR_REPO = 'keybank/WIR00/wire-transfer-service';

const PKG = 'src/main/java/com/keybank/wir';

export const WIR_PATHS = {
  routingClient: `${PKG}/client/RoutingDirectoryClient.java`,
  beneficiaryValidator: `${PKG}/validation/BeneficiaryBankValidator.java`,
} as const;

const ROUTING_CLIENT = `package com.keybank.wir.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** routing-directory-service (ABA) client. */
@Component
public class RoutingDirectoryClient {

  public record RoutingValidation(String routingNumber, boolean valid, String reason) {}

  private final RestClient http;

  public RoutingDirectoryClient(
      RestClient.Builder builder, @Value("\${wire.clients.aba-base-url}") String baseUrl) {
    this.http = builder.baseUrl(baseUrl).defaultHeader("X-Client-Id", "wire-transfer-service").build();
  }

  public RoutingValidation validate(String routingNumber) {
    return http.get()
        .uri("/v1/routing-numbers/{rtn}/validate", routingNumber)
        .retrieve()
        .body(RoutingValidation.class);
  }
}
`;

export const WIR_BENEFICIARY_VALIDATOR = `package com.keybank.wir.validation;

import com.keybank.wir.client.RoutingDirectoryClient;
import com.keybank.wir.client.RoutingDirectoryClient.RoutingValidation;
import java.math.BigDecimal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/** Domestic (Fedwire) wires: the beneficiary bank ABA must pass routing directory validation. */
@Component
public class BeneficiaryBankValidator {

  private static final Logger log = LoggerFactory.getLogger(BeneficiaryBankValidator.class);

  private final RoutingDirectoryClient directory;

  public BeneficiaryBankValidator(RoutingDirectoryClient directory) {
    this.directory = directory;
  }

  public record WireRequest(
      String wireId, String beneficiaryBankAba, String beneficiaryAccountMasked, BigDecimal amount, String channel) {}

  public void validate(WireRequest wire) {
    RoutingValidation result = directory.validate(wire.beneficiaryBankAba());
    if (!result.valid()) {
      log.error(
          "Wire {} rejected: beneficiary bank ABA {} failed validation ({}) amount={} channel={}",
          wire.wireId(), wire.beneficiaryBankAba(), result.reason(), wire.amount(), wire.channel());
      throw new WireValidationException(
          wire.wireId(), "INVALID_BENEFICIARY_BANK", "Beneficiary bank routing number failed validation: " + result.reason());
    }
  }

  public static class WireValidationException extends RuntimeException {
    private final String code;

    public WireValidationException(String wireId, String code, String message) {
      super("Wire " + wireId + ": " + message);
      this.code = code;
    }

    public String getCode() {
      return code;
    }
  }
}
`;

export const wirOverlay: RepoOverlay = {
  complete: false,
  files: {
    [WIR_PATHS.routingClient]: ROUTING_CLIENT,
    [WIR_PATHS.beneficiaryValidator]: WIR_BENEFICIARY_VALIDATOR,
  },
};
