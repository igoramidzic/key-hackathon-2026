import type { RepoOverlay } from '../types';

/** keybank/PAY00/payments-api: payment orchestration across ACH, wire and book transfers. */
export const PAY_REPO = 'keybank/PAY00/payments-api';

const PKG = 'src/main/java/com/keybank/pay';

export const PAY_PATHS = {
  profileClient: `${PKG}/client/CustomerProfileClient.java`,
  profile: `${PKG}/client/CustomerProfile.java`,
  payerVerification: `${PKG}/service/PayerVerificationService.java`,
  controller: `${PKG}/api/PaymentController.java`,
} as const;

export const PAY_PROFILE_CLIENT = `package com.keybank.pay.client;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * CIF customer-profile-api client.
 *
 * <p>Payments bind the CIF contract strictly (FAIL_ON_UNKNOWN_PROPERTIES): if the contract
 * changes under us we would rather fail the payment than move money on a partial profile.
 */
@Component
public class CustomerProfileClient {

  private static final Logger log = LoggerFactory.getLogger(CustomerProfileClient.class);

  private final RestClient http;

  public CustomerProfileClient(
      RestClient.Builder builder,
      ObjectMapper mapper,
      @Value("\${payments.clients.cif-base-url}") String baseUrl) {
    ObjectMapper strict = mapper.copy().enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    this.http =
        builder
            .baseUrl(baseUrl)
            .messageConverters(
                converters -> {
                  converters.removeIf(c -> c instanceof MappingJackson2HttpMessageConverter);
                  converters.add(new MappingJackson2HttpMessageConverter(strict));
                })
            .build();
  }

  public CustomerProfile getProfile(String customerId) {
    try {
      return http.get()
          .uri("/v1/customers/{customerId}/profile", customerId)
          .retrieve()
          .body(CustomerProfile.class);
    } catch (RestClientException ex) {
      log.error("Customer profile lookup failed for {}: {}", customerId, ex.getMessage(), ex);
      throw new CustomerProfileUnavailableException(customerId, ex);
    }
  }

  public static class CustomerProfileUnavailableException extends RuntimeException {
    public CustomerProfileUnavailableException(String customerId, Throwable cause) {
      super("CIF profile unavailable for " + customerId, cause);
    }
  }
}
`;

const PROFILE = `package com.keybank.pay.client;

import java.time.LocalDate;
import java.time.OffsetDateTime;

/** Mirror of the customer-profile-api v2 contract (generated from its OpenAPI spec, 2.13.0). */
public record CustomerProfile(
    String customerId,
    String firstName,
    String lastName,
    LocalDate dateOfBirth,
    String primaryEmail,
    String mobilePhone,
    Address mailingAddress,
    String segment,
    String kycStatus,
    String riskRating,
    ContactPreferences contactPreferences,
    OffsetDateTime customerSince,
    OffsetDateTime lastUpdated) {

  public record Address(
      String line1, String line2, String city, String state, String postalCode) {}

  public record ContactPreferences(
      boolean email, boolean sms, boolean push, String preferredChannel) {}
}
`;

export const PAY_PAYER_VERIFICATION = `package com.keybank.pay.service;

import com.keybank.pay.client.CustomerProfile;
import com.keybank.pay.client.CustomerProfileClient;
import org.springframework.stereotype.Service;

/** KYC gate in front of every money movement. */
@Service
public class PayerVerificationService {

  private final CustomerProfileClient profiles;

  public PayerVerificationService(CustomerProfileClient profiles) {
    this.profiles = profiles;
  }

  /** The payer must be a verified CIF customer that is not rated high risk. */
  public CustomerProfile verifyPayer(String customerId) {
    CustomerProfile payer = profiles.getProfile(customerId);
    if (!"VERIFIED".equals(payer.kycStatus()) || "HIGH".equals(payer.riskRating())) {
      throw new PayerNotEligibleException(customerId, payer.kycStatus(), payer.riskRating());
    }
    return payer;
  }

  public static class PayerNotEligibleException extends RuntimeException {
    public PayerNotEligibleException(String customerId, String kycStatus, String riskRating) {
      super("Payer " + customerId + " not eligible (kyc=" + kycStatus + ", risk=" + riskRating + ")");
    }
  }
}
`;

export const PAY_CONTROLLER = `package com.keybank.pay.api;

import com.keybank.pay.client.CustomerProfile;
import com.keybank.pay.client.CustomerProfileClient.CustomerProfileUnavailableException;
import com.keybank.pay.service.PayerVerificationService;
import com.keybank.pay.service.PaymentOrchestrator;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import java.math.BigDecimal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v1/payments")
public class PaymentController {

  private static final Logger log = LoggerFactory.getLogger(PaymentController.class);

  private final PayerVerificationService payers;
  private final PaymentOrchestrator orchestrator;

  public PaymentController(PayerVerificationService payers, PaymentOrchestrator orchestrator) {
    this.payers = payers;
    this.orchestrator = orchestrator;
  }

  public record PaymentRequest(
      @NotBlank String paymentId,
      @NotBlank String customerId,
      @NotBlank String fromAccount,
      @NotBlank String rail,
      @NotBlank String beneficiaryRoutingNumber,
      @NotBlank String beneficiaryAccount,
      @DecimalMin("0.01") BigDecimal amount) {}

  @PostMapping
  public ResponseEntity<PaymentOrchestrator.Submitted> createPayment(
      @Valid @RequestBody PaymentRequest request) {
    CustomerProfile payer = payers.verifyPayer(request.customerId());
    return ResponseEntity.status(HttpStatus.ACCEPTED).body(orchestrator.submit(request, payer));
  }

  @ExceptionHandler(CustomerProfileUnavailableException.class)
  ResponseEntity<ProblemDetail> payerUnavailable(
      CustomerProfileUnavailableException ex, HttpServletRequest request) {
    log.error("Payment rejected: payer verification unavailable ({}) path={}", ex.getMessage(), request.getRequestURI());
    ProblemDetail problem =
        ProblemDetail.forStatusAndDetail(HttpStatus.BAD_GATEWAY, "Payer verification unavailable");
    problem.setProperty("code", "PAYER_VERIFICATION_UNAVAILABLE");
    return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(problem);
  }
}
`;

export const payOverlay: RepoOverlay = {
  complete: false,
  files: {
    [PAY_PATHS.profileClient]: PAY_PROFILE_CLIENT,
    [PAY_PATHS.profile]: PROFILE,
    [PAY_PATHS.payerVerification]: PAY_PAYER_VERIFICATION,
    [PAY_PATHS.controller]: PAY_CONTROLLER,
  },
};
