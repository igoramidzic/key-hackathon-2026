import type { RepoOverlay } from '../types';
import { CIF_SECURITY } from './cif';
import { springPom } from './common';

/** keybank/CRD00/card-management-api: debit/credit card controls, limits and lifecycle. */
export const CRD_REPO = 'keybank/CRD00/card-management-api';

const PKG = 'src/main/java/com/keybank/crd';
const TEST = 'src/test/java/com/keybank/crd';

export const CRD_PATHS = {
  applicationYml: 'src/main/resources/application.yml',
  controller: `${PKG}/api/CardController.java`,
  exceptionHandler: `${PKG}/api/ApiExceptionHandler.java`,
  service: `${PKG}/service/CardControlService.java`,
  profileClient: `${PKG}/client/CustomerProfileClient.java`,
  security: `${PKG}/config/SecurityConfig.java`,
} as const;

/** The pool block the "right-size" MR rewrites. */
export const CRD_HIKARI_ORIGINAL = `    hikari:
      maximum-pool-size: 40
      minimum-idle: 10
      connection-timeout: 10000`;

export const CRD_HIKARI_BAD = `    hikari:
      # Right-sized per DBA review DBA-1187: p95 of 3.2 active connections per pod over 30 days.
      # 8 pods x 5 = 40 connections (was 8 x 40 = 320 against max_connections = 400).
      maximum-pool-size: 5
      minimum-idle: 2
      connection-timeout: 2000`;

export const CRD_APPLICATION_YML = `server:
  port: 8080
  shutdown: graceful
  tomcat:
    threads:
      max: 200

spring:
  application:
    name: card-management-api
  datasource:
    url: jdbc:postgresql://crd-pg-prod.internal.keybank.example:5432/cardmgmt
    username: \${CRD_DB_USER}
    password: \${CRD_DB_PASSWORD}
${CRD_HIKARI_ORIGINAL}
      idle-timeout: 600000
      max-lifetime: 1800000
      leak-detection-threshold: 30000
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
  flyway:
    enabled: true
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.internal.keybank.example
          jwk-set-uri: https://auth.internal.keybank.example/.well-known/jwks.json
      client:
        registration:
          crd-service:
            provider: ath
            client-id: crd-api
            client-secret: \${CRD_OAUTH_CLIENT_SECRET}
            authorization-grant-type: client_credentials
            scope: cif.read
        provider:
          ath:
            token-uri: https://auth.internal.keybank.example/oauth2/token

card:
  clients:
    cif-base-url: https://cif.internal.keybank.example
  controls:
    max-daily-limit: 5000.00

management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  metrics:
    enable:
      hikaricp: true

logging:
  structured:
    format:
      console: logstash
  level:
    root: INFO
    com.keybank.crd: INFO
`;

const APPLICATION = `package com.keybank.crd;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class CardManagementApplication {

  public static void main(String[] args) {
    SpringApplication.run(CardManagementApplication.class, args);
  }
}
`;

export const CRD_CONTROLLER = `package com.keybank.crd.api;

import com.keybank.crd.api.dto.CardControlsRequest;
import com.keybank.crd.api.dto.CardResponse;
import com.keybank.crd.service.CardControlService;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Card controls for digital channels (MBL, OLB). The token subject is the customer id. */
@RestController
@RequestMapping("/v1")
public class CardController {

  private final CardControlService cards;

  public CardController(CardControlService cards) {
    this.cards = cards;
  }

  @GetMapping("/customers/{customerId}/cards")
  public List<CardResponse> listCards(
      @PathVariable String customerId, @AuthenticationPrincipal Jwt jwt) {
    return cards.listCards(customerId, jwt.getSubject());
  }

  @GetMapping("/cards/{cardId}")
  public CardResponse getCard(@PathVariable UUID cardId, @AuthenticationPrincipal Jwt jwt) {
    return cards.getCard(cardId, jwt.getSubject());
  }

  @PutMapping("/cards/{cardId}/controls")
  public CardResponse updateControls(
      @PathVariable UUID cardId,
      @Valid @RequestBody CardControlsRequest request,
      @AuthenticationPrincipal Jwt jwt) {
    return cards.updateControls(cardId, jwt.getSubject(), request);
  }
}
`;

export const CRD_EXCEPTION_HANDLER = `package com.keybank.crd.api;

import com.keybank.crd.service.CardControlService.CardNotFoundException;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.transaction.CannotCreateTransactionException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

  @ExceptionHandler(CardNotFoundException.class)
  ProblemDetail notFound(CardNotFoundException ex) {
    return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
  }

  @ExceptionHandler(AccessDeniedException.class)
  ProblemDetail forbidden(AccessDeniedException ex) {
    return ProblemDetail.forStatusAndDetail(HttpStatus.FORBIDDEN, "Card does not belong to caller");
  }

  /** Database unavailable or connection pool exhausted: tell callers to retry. */
  @ExceptionHandler({CannotCreateTransactionException.class, DataAccessResourceFailureException.class})
  ProblemDetail unavailable(Exception ex, HttpServletRequest request) {
    log.error("{} {} failed: database unavailable", request.getMethod(), request.getRequestURI(), ex);
    ProblemDetail problem =
        ProblemDetail.forStatusAndDetail(HttpStatus.SERVICE_UNAVAILABLE, "Card service temporarily unavailable");
    problem.setProperty("retryable", true);
    return problem;
  }

  @ExceptionHandler(Exception.class)
  ProblemDetail unexpected(Exception ex, HttpServletRequest request) {
    log.error("Unhandled exception on {} {}", request.getMethod(), request.getRequestURI(), ex);
    return ProblemDetail.forStatusAndDetail(HttpStatus.INTERNAL_SERVER_ERROR, "Unexpected error");
  }
}
`;

const CARD_RESPONSE = `package com.keybank.crd.api.dto;

import com.keybank.crd.domain.Card;
import java.math.BigDecimal;
import java.util.UUID;

public record CardResponse(
    UUID cardId,
    String panLast4,
    String productCode,
    String status,
    boolean locked,
    boolean onlinePurchasesEnabled,
    boolean internationalEnabled,
    BigDecimal dailyLimit) {

  public static CardResponse from(Card card) {
    return new CardResponse(
        card.getId(),
        card.getPanLast4(),
        card.getProductCode(),
        card.getStatus(),
        card.isLocked(),
        card.isOnlinePurchasesEnabled(),
        card.isInternationalEnabled(),
        card.getDailyLimit());
  }
}
`;

const CARD_CONTROLS_REQUEST = `package com.keybank.crd.api.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;

public record CardControlsRequest(
    @NotNull Boolean locked,
    @NotNull Boolean onlinePurchasesEnabled,
    @NotNull Boolean internationalEnabled,
    @DecimalMin("0.00") @DecimalMax("5000.00") BigDecimal dailyLimit) {}
`;

const CARD_ENTITY = `package com.keybank.crd.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.UUID;

@Entity
@Table(name = "card")
public class Card {

  @Id private UUID id;
  private String customerId;
  private String panLast4;
  private String productCode;
  private String status;
  private boolean locked;
  private boolean onlinePurchasesEnabled;
  private boolean internationalEnabled;
  private BigDecimal dailyLimit;
  private OffsetDateTime updatedAt;
  @Version private long version;

  protected Card() {}

  public void applyControls(
      boolean locked, boolean online, boolean international, BigDecimal dailyLimit) {
    this.locked = locked;
    this.onlinePurchasesEnabled = online;
    this.internationalEnabled = international;
    if (dailyLimit != null) this.dailyLimit = dailyLimit;
    this.updatedAt = OffsetDateTime.now();
  }

  public UUID getId() { return id; }
  public String getCustomerId() { return customerId; }
  public String getPanLast4() { return panLast4; }
  public String getProductCode() { return productCode; }
  public String getStatus() { return status; }
  public boolean isLocked() { return locked; }
  public boolean isOnlinePurchasesEnabled() { return onlinePurchasesEnabled; }
  public boolean isInternationalEnabled() { return internationalEnabled; }
  public BigDecimal getDailyLimit() { return dailyLimit; }
  public OffsetDateTime getUpdatedAt() { return updatedAt; }
}
`;

const CARD_REPOSITORY = `package com.keybank.crd.domain;

import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface CardRepository extends JpaRepository<Card, UUID> {

  List<Card> findByCustomerIdOrderByProductCode(String customerId);

  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("select c from Card c where c.id = :id")
  Optional<Card> findByIdForUpdate(@Param("id") UUID id);
}
`;

export const CRD_SERVICE = `package com.keybank.crd.service;

import com.keybank.crd.api.dto.CardControlsRequest;
import com.keybank.crd.api.dto.CardResponse;
import com.keybank.crd.client.CustomerProfile;
import com.keybank.crd.client.CustomerProfileClient;
import com.keybank.crd.domain.Card;
import com.keybank.crd.domain.CardRepository;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class CardControlService {

  private static final Logger log = LoggerFactory.getLogger(CardControlService.class);

  private final CardRepository cards;
  private final CustomerProfileClient profiles;

  public CardControlService(CardRepository cards, CustomerProfileClient profiles) {
    this.cards = cards;
    this.profiles = profiles;
  }

  @Transactional(readOnly = true)
  public List<CardResponse> listCards(String customerId, String caller) {
    if (!customerId.equals(caller)) throw new AccessDeniedException("caller mismatch");
    return cards.findByCustomerIdOrderByProductCode(customerId).stream()
        .map(CardResponse::from)
        .toList();
  }

  @Transactional(readOnly = true)
  public CardResponse getCard(UUID cardId, String caller) {
    Card card = cards.findById(cardId).orElseThrow(() -> new CardNotFoundException(cardId));
    assertActiveCardholder(card, caller);
    return CardResponse.from(card);
  }

  @Transactional
  public CardResponse updateControls(UUID cardId, String caller, CardControlsRequest req) {
    Card card = cards.findByIdForUpdate(cardId).orElseThrow(() -> new CardNotFoundException(cardId));
    assertActiveCardholder(card, caller);
    card.applyControls(
        req.locked(), req.onlinePurchasesEnabled(), req.internationalEnabled(), req.dailyLimit());
    log.info("Card controls updated card={} locked={} online={} intl={}",
        cardId, req.locked(), req.onlinePurchasesEnabled(), req.internationalEnabled());
    return CardResponse.from(card);
  }

  /**
   * The caller must be the cardholder, and CIF (system of record for customer status) must
   * still consider them an active, verified customer.
   */
  private void assertActiveCardholder(Card card, String caller) {
    if (!card.getCustomerId().equals(caller)) {
      throw new AccessDeniedException("Card " + card.getId() + " does not belong to caller");
    }
    CustomerProfile holder = profiles.getProfile(caller);
    if (!holder.customerId().equals(card.getCustomerId()) || "BLOCKED".equals(holder.kycStatus())) {
      throw new AccessDeniedException("Cardholder " + caller + " is not active in CIF");
    }
  }

  public static class CardNotFoundException extends RuntimeException {
    public CardNotFoundException(UUID cardId) {
      super("Card not found: " + cardId);
    }
  }
}
`;

export const CRD_PROFILE_CLIENT = `package com.keybank.crd.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.oauth2.client.OAuth2AuthorizedClientManager;
import org.springframework.security.oauth2.client.web.client.OAuth2ClientHttpRequestInterceptor;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** CIF customer-profile-api client (service token: crd-api, scope cif.read). */
@Component
public class CustomerProfileClient {

  private final RestClient http;

  public CustomerProfileClient(
      RestClient.Builder builder,
      OAuth2AuthorizedClientManager authorizedClients,
      @Value("\${card.clients.cif-base-url}") String baseUrl) {
    OAuth2ClientHttpRequestInterceptor serviceToken =
        new OAuth2ClientHttpRequestInterceptor(authorizedClients);
    serviceToken.setClientRegistrationIdResolver(request -> "crd-service");
    this.http = builder.baseUrl(baseUrl).requestInterceptor(serviceToken).build();
  }

  public CustomerProfile getProfile(String customerId) {
    return http.get()
        .uri("/v1/customers/{customerId}/profile", customerId)
        .retrieve()
        .body(CustomerProfile.class);
  }
}
`;

const CUSTOMER_PROFILE = `package com.keybank.crd.client;

/** The subset of the CIF profile CRD needs. */
public record CustomerProfile(
    String customerId, String firstName, String lastName, String kycStatus, String segment) {}
`;

const MIGRATION = `create table card (
  id                        uuid          primary key,
  customer_id               varchar(12)   not null,
  pan_last4                 char(4)       not null,
  product_code              varchar(20)   not null,
  status                    varchar(12)   not null,
  locked                    boolean       not null default false,
  online_purchases_enabled  boolean       not null default true,
  international_enabled     boolean       not null default false,
  daily_limit               numeric(12,2) not null default 1000.00,
  updated_at                timestamptz   not null default now(),
  version                   bigint        not null default 0
);

create index card_customer_idx on card (customer_id);
`;

const SERVICE_TEST = `package com.keybank.crd.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.keybank.crd.api.dto.CardControlsRequest;
import com.keybank.crd.client.CustomerProfile;
import com.keybank.crd.client.CustomerProfileClient;
import com.keybank.crd.domain.Card;
import com.keybank.crd.domain.CardRepository;
import java.math.BigDecimal;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;

class CardControlServiceTest {

  private final CardRepository cards = mock(CardRepository.class);
  private final CustomerProfileClient profiles = mock(CustomerProfileClient.class);
  private final CardControlService service = new CardControlService(cards, profiles);

  private final UUID cardId = UUID.fromString("5b0c1c9e-8a0e-4c55-9d5f-0d7a3f1e2b11");

  @Test
  void locksCardForCardholder() {
    Card card = card("C10458213");
    when(cards.findByIdForUpdate(cardId)).thenReturn(Optional.of(card));
    when(profiles.getProfile("C10458213"))
        .thenReturn(new CustomerProfile("C10458213", "Jordan", "Ellis", "VERIFIED", "RETAIL"));

    var res = service.updateControls(cardId, "C10458213", new CardControlsRequest(true, true, false, null));

    assertThat(res.locked()).isTrue();
  }

  @Test
  void rejectsOtherCustomers() {
    when(cards.findByIdForUpdate(cardId)).thenReturn(Optional.of(card("C10458213")));

    assertThatThrownBy(
            () -> service.updateControls(cardId, "C20000001", new CardControlsRequest(true, true, false, null)))
        .isInstanceOf(AccessDeniedException.class);
  }

  @Test
  void rejectsBlockedCustomers() {
    when(cards.findByIdForUpdate(cardId)).thenReturn(Optional.of(card("C10458213")));
    when(profiles.getProfile("C10458213"))
        .thenReturn(new CustomerProfile("C10458213", "Jordan", "Ellis", "BLOCKED", "RETAIL"));

    assertThatThrownBy(
            () -> service.updateControls(cardId, "C10458213", new CardControlsRequest(true, true, false, null)))
        .isInstanceOf(AccessDeniedException.class);
  }

  private Card card(String customerId) {
    Card card = mock(Card.class);
    when(card.getId()).thenReturn(cardId);
    when(card.getCustomerId()).thenReturn(customerId);
    when(card.isLocked()).thenReturn(true);
    when(card.getDailyLimit()).thenReturn(new BigDecimal("1000.00"));
    return card;
  }
}
`;

export const crdOverlay: RepoOverlay = {
  complete: true,
  files: {
    'pom.xml': springPom({
      tla: 'CRD',
      artifactId: 'card-management-api',
      version: '4.6.2',
      description: 'Card controls, limits and lifecycle API',
      extraDependencies: [
        `    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-oauth2-client</artifactId>
    </dependency>`,
      ],
    }),
    [CRD_PATHS.applicationYml]: CRD_APPLICATION_YML,
    [`${PKG}/CardManagementApplication.java`]: APPLICATION,
    [CRD_PATHS.controller]: CRD_CONTROLLER,
    [CRD_PATHS.exceptionHandler]: CRD_EXCEPTION_HANDLER,
    [`${PKG}/api/dto/CardResponse.java`]: CARD_RESPONSE,
    [`${PKG}/api/dto/CardControlsRequest.java`]: CARD_CONTROLS_REQUEST,
    [`${PKG}/domain/Card.java`]: CARD_ENTITY,
    [`${PKG}/domain/CardRepository.java`]: CARD_REPOSITORY,
    [CRD_PATHS.service]: CRD_SERVICE,
    [CRD_PATHS.profileClient]: CRD_PROFILE_CLIENT,
    [`${PKG}/client/CustomerProfile.java`]: CUSTOMER_PROFILE,
    [CRD_PATHS.security]: CIF_SECURITY.replace(
      'package com.keybank.cif.config;',
      'package com.keybank.crd.config;',
    )
      .replace('HttpMethod.GET, "/v1/customers/**"', 'HttpMethod.GET, "/v1/**"')
      .replace('"SCOPE_cif.read"', '"SCOPE_cards.read"'),
    'src/main/resources/db/migration/V1__cards.sql': MIGRATION,
    [`${TEST}/service/CardControlServiceTest.java`]: SERVICE_TEST,
  },
};
