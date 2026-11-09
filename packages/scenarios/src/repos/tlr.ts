import type { RepoOverlay } from '../types';
import { springPom } from './common';

/** keybank/TLR00/teller-workstation-api: branch teller transactions, drawers and balancing. */
export const TLR_REPO = 'keybank/TLR00/teller-workstation-api';

const PKG = 'src/main/java/com/keybank/tlr';
const TEST = 'src/test/java/com/keybank/tlr';

export const TLR_PATHS = {
  applicationYml: 'src/main/resources/application.yml',
  properties: `${PKG}/config/BusinessDayProperties.java`,
  businessDateService: `${PKG}/service/BusinessDateService.java`,
  transactionService: `${PKG}/service/TellerTransactionService.java`,
  drawerBalancing: `${PKG}/service/DrawerBalancingService.java`,
  transaction: `${PKG}/domain/TellerTransaction.java`,
  glClient: `${PKG}/client/GlPostingClient.java`,
  profileClient: `${PKG}/client/CustomerProfileClient.java`,
  controller: `${PKG}/api/TellerController.java`,
  businessDateTest: `${TEST}/service/BusinessDateServiceTest.java`,
  transactionServiceTest: `${TEST}/service/TellerTransactionServiceTest.java`,
} as const;

/** The business-day block. The UTC MR flips `timezone`. */
export const TLR_BUSINESS_DAY_TZ = '    timezone: America/New_York';
export const TLR_BUSINESS_DAY_TZ_BAD = `    # All timestamps are UTC (EAS-207); the business date derives from the same clock.
    timezone: UTC`;

export const TLR_APPLICATION_YML = `server:
  port: 8080
  shutdown: graceful

spring:
  application:
    name: teller-workstation-api
  datasource:
    url: jdbc:postgresql://tlr-pg-prod.internal.keybank.example:5432/teller
    username: \${TLR_DB_USER}
    password: \${TLR_DB_PASSWORD}
    hikari:
      maximum-pool-size: 30
      connection-timeout: 5000
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

teller:
  business-day:
${TLR_BUSINESS_DAY_TZ}
    # Teller transactions at or after the cutoff post to the next business day.
    posting-cutoff: "19:00"
    holidays:
      - 2026-11-11
      - 2026-11-26
      - 2026-12-25
      - 2027-01-01
      - 2027-01-18
      - 2027-02-15
  drawer:
    variance-tolerance: 5.00
  clients:
    cif-base-url: https://cif.internal.keybank.example
    gl-base-url: https://gl.internal.keybank.example

management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: health,info,prometheus

logging:
  structured:
    format:
      console: logstash
  level:
    root: INFO
    com.keybank.tlr: INFO
`;

/** application.yml after "Use UTC consistently for transaction timestamps". */
export const TLR_APPLICATION_YML_BAD = TLR_APPLICATION_YML.replace(
  `  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
`,
  `  jackson:
    time-zone: UTC
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
    properties:
      hibernate:
        jdbc:
          time_zone: UTC
`,
).replace(TLR_BUSINESS_DAY_TZ, TLR_BUSINESS_DAY_TZ_BAD);

const APPLICATION = `package com.keybank.tlr;

import com.keybank.tlr.config.BusinessDayProperties;
import java.time.Clock;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
@EnableConfigurationProperties(BusinessDayProperties.class)
public class TellerWorkstationApplication {

  public static void main(String[] args) {
    SpringApplication.run(TellerWorkstationApplication.class, args);
  }

  @Bean
  Clock clock() {
    return Clock.systemUTC();
  }
}
`;

export const TLR_PROPERTIES = `package com.keybank.tlr.config;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.HashSet;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "teller.business-day")
public class BusinessDayProperties {

  /** Time zone that defines the bank's business day (branch operations run on Eastern time). */
  private String timezone = "America/New_York";

  /** Transactions at or after this local time post to the next business day. */
  private LocalTime postingCutoff = LocalTime.of(19, 0);

  /** Federal Reserve holidays: no business date falls on these. */
  private Set<LocalDate> holidays = new HashSet<>();

  public String getTimezone() { return timezone; }
  public void setTimezone(String timezone) { this.timezone = timezone; }
  public LocalTime getPostingCutoff() { return postingCutoff; }
  public void setPostingCutoff(LocalTime postingCutoff) { this.postingCutoff = postingCutoff; }
  public Set<LocalDate> getHolidays() { return holidays; }
  public void setHolidays(Set<LocalDate> holidays) { this.holidays = holidays; }
}
`;

export const TLR_BUSINESS_DATE_SERVICE = `package com.keybank.tlr.service;

import com.keybank.tlr.config.BusinessDayProperties;
import java.time.Clock;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import org.springframework.stereotype.Service;

/** Decides which business date a teller transaction posts to. */
@Service
public class BusinessDateService {

  private final Clock clock;
  private final BusinessDayProperties properties;

  public BusinessDateService(Clock clock, BusinessDayProperties properties) {
    this.clock = clock;
    this.properties = properties;
  }

  /** Business date for a transaction posted right now. */
  public LocalDate currentBusinessDate() {
    ZonedDateTime now = ZonedDateTime.now(clock.withZone(businessZone()));
    LocalDate date = now.toLocalDate();
    if (!now.toLocalTime().isBefore(properties.getPostingCutoff())) {
      date = date.plusDays(1);
    }
    return onOrAfterNextBusinessDay(date);
  }

  ZoneId businessZone() {
    return ZoneId.of(properties.getTimezone());
  }

  private LocalDate onOrAfterNextBusinessDay(LocalDate date) {
    LocalDate d = date;
    while (d.getDayOfWeek() == DayOfWeek.SATURDAY
        || d.getDayOfWeek() == DayOfWeek.SUNDAY
        || properties.getHolidays().contains(d)) {
      d = d.plusDays(1);
    }
    return d;
  }
}
`;

const TRANSACTION = `package com.keybank.tlr.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Entity
@Table(name = "teller_transaction")
public class TellerTransaction {

  @Id private String id;
  private String branchId;
  private String drawerId;
  private String tellerId;
  private String type;
  private String accountNumber;
  private BigDecimal amount;
  private BigDecimal cashIn;
  private BigDecimal cashOut;
  private LocalDate businessDate;
  private LocalDateTime postedAt;

  protected TellerTransaction() {}

  public TellerTransaction(
      String id, String branchId, String drawerId, String tellerId, String type,
      String accountNumber, BigDecimal amount, BigDecimal cashIn, BigDecimal cashOut) {
    this.id = id;
    this.branchId = branchId;
    this.drawerId = drawerId;
    this.tellerId = tellerId;
    this.type = type;
    this.accountNumber = accountNumber;
    this.amount = amount;
    this.cashIn = cashIn;
    this.cashOut = cashOut;
  }

  public String getId() { return id; }
  public String getBranchId() { return branchId; }
  public String getDrawerId() { return drawerId; }
  public String getTellerId() { return tellerId; }
  public String getType() { return type; }
  public String getAccountNumber() { return accountNumber; }
  public BigDecimal getAmount() { return amount; }
  public BigDecimal getCashIn() { return cashIn; }
  public BigDecimal getCashOut() { return cashOut; }
  public LocalDate getBusinessDate() { return businessDate; }
  public void setBusinessDate(LocalDate businessDate) { this.businessDate = businessDate; }
  public LocalDateTime getPostedAt() { return postedAt; }
  public void setPostedAt(LocalDateTime postedAt) { this.postedAt = postedAt; }
}
`;

const TRANSACTION_BAD = TRANSACTION.replace(
  'import java.time.LocalDate;\nimport java.time.LocalDateTime;',
  'import java.time.Instant;\nimport java.time.LocalDate;',
)
  .replace('private LocalDateTime postedAt;', 'private Instant postedAt;')
  .replace(
    '  public LocalDateTime getPostedAt() { return postedAt; }\n  public void setPostedAt(LocalDateTime postedAt) { this.postedAt = postedAt; }',
    '  public Instant getPostedAt() { return postedAt; }\n  public void setPostedAt(Instant postedAt) { this.postedAt = postedAt; }',
  );

const TRANSACTION_REPOSITORY = `package com.keybank.tlr.domain;

import java.math.BigDecimal;
import java.time.LocalDate;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface TellerTransactionRepository extends JpaRepository<TellerTransaction, String> {

  /** Net cash movement of a drawer for one business date. */
  @Query(
      "select coalesce(sum(t.cashIn - t.cashOut), 0) from TellerTransaction t "
          + "where t.drawerId = :drawerId and t.businessDate = :businessDate")
  BigDecimal sumNetCash(
      @Param("drawerId") String drawerId, @Param("businessDate") LocalDate businessDate);
}
`;

const DRAWER_SESSION = `package com.keybank.tlr.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.LocalDate;

/** A teller's cash drawer for one business day, opened in the morning and balanced at close. */
@Entity
@Table(name = "drawer_session")
public class DrawerSession {

  @Id private String id;
  private String branchId;
  private String drawerId;
  private String tellerId;
  private LocalDate businessDate;
  private BigDecimal openingCash;
  private BigDecimal closingCash;
  private String status;

  protected DrawerSession() {}

  public void close(BigDecimal countedCash) {
    this.closingCash = countedCash;
    this.status = "BALANCED";
  }

  public String getId() { return id; }
  public String getBranchId() { return branchId; }
  public String getDrawerId() { return drawerId; }
  public String getTellerId() { return tellerId; }
  public LocalDate getBusinessDate() { return businessDate; }
  public BigDecimal getOpeningCash() { return openingCash; }
  public String getStatus() { return status; }
}
`;

const DRAWER_SESSION_REPOSITORY = `package com.keybank.tlr.domain;

import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface DrawerSessionRepository extends JpaRepository<DrawerSession, String> {

  @Query("select s from DrawerSession s where s.drawerId = :drawerId and s.status = 'OPEN'")
  Optional<DrawerSession> findOpen(@Param("drawerId") String drawerId);
}
`;

export const TLR_TRANSACTION_SERVICE = `package com.keybank.tlr.service;

import com.keybank.tlr.client.GlPostingClient;
import com.keybank.tlr.domain.DrawerSession;
import com.keybank.tlr.domain.DrawerSessionRepository;
import com.keybank.tlr.domain.TellerTransaction;
import com.keybank.tlr.domain.TellerTransactionRepository;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TellerTransactionService {

  private static final Logger log = LoggerFactory.getLogger(TellerTransactionService.class);

  private final Clock clock;
  private final BusinessDateService businessDates;
  private final DrawerSessionRepository sessions;
  private final TellerTransactionRepository transactions;
  private final GlPostingClient gl;

  public TellerTransactionService(
      Clock clock,
      BusinessDateService businessDates,
      DrawerSessionRepository sessions,
      TellerTransactionRepository transactions,
      GlPostingClient gl) {
    this.clock = clock;
    this.businessDates = businessDates;
    this.sessions = sessions;
    this.transactions = transactions;
    this.gl = gl;
  }

  public record PostTransactionCommand(
      String drawerId, String type, String accountNumber, BigDecimal amount,
      BigDecimal cashIn, BigDecimal cashOut) {}

  @Transactional
  public TellerTransaction post(PostTransactionCommand cmd) {
    DrawerSession session =
        sessions
            .findOpen(cmd.drawerId())
            .orElseThrow(() -> new IllegalStateException("No open session for drawer " + cmd.drawerId()));

    LocalDate businessDate = businessDates.currentBusinessDate();
    if (!businessDate.equals(session.getBusinessDate())) {
      log.warn(
          "Transaction business date {} differs from drawer session business date {} (branch={} drawer={}); posting to {}",
          businessDate,
          session.getBusinessDate(),
          session.getBranchId(),
          session.getDrawerId(),
          businessDate);
    }

    TellerTransaction tx =
        new TellerTransaction(
            "TT-" + UUID.randomUUID(), session.getBranchId(), session.getDrawerId(),
            session.getTellerId(), cmd.type(), cmd.accountNumber(), cmd.amount(),
            cmd.cashIn(), cmd.cashOut());
    tx.setBusinessDate(businessDate);
    tx.setPostedAt(LocalDateTime.now(clock));
    transactions.save(tx);
    gl.post(tx);
    return tx;
  }
}
`;

const TRANSACTION_SERVICE_BAD = TLR_TRANSACTION_SERVICE.replace(
  'import java.time.Clock;\nimport java.time.LocalDate;\nimport java.time.LocalDateTime;',
  'import java.time.Clock;\nimport java.time.Instant;\nimport java.time.LocalDate;',
).replace('tx.setPostedAt(LocalDateTime.now(clock));', 'tx.setPostedAt(Instant.now(clock));');

export const TLR_DRAWER_BALANCING = `package com.keybank.tlr.service;

import com.keybank.tlr.domain.DrawerSession;
import com.keybank.tlr.domain.DrawerSessionRepository;
import com.keybank.tlr.domain.TellerTransactionRepository;
import java.math.BigDecimal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class DrawerBalancingService {

  private static final Logger log = LoggerFactory.getLogger(DrawerBalancingService.class);

  private final DrawerSessionRepository sessions;
  private final TellerTransactionRepository transactions;
  private final BigDecimal tolerance;

  public DrawerBalancingService(
      DrawerSessionRepository sessions,
      TellerTransactionRepository transactions,
      @Value("\${teller.drawer.variance-tolerance}") BigDecimal tolerance) {
    this.sessions = sessions;
    this.transactions = transactions;
    this.tolerance = tolerance;
  }

  public record BalanceResult(boolean balanced, BigDecimal expected, BigDecimal counted, BigDecimal variance) {}

  /** Compares counted cash with opening cash plus the drawer's net cash for its business date. */
  @Transactional
  public BalanceResult balance(String drawerId, BigDecimal countedCash) {
    DrawerSession session =
        sessions.findOpen(drawerId).orElseThrow(() -> new IllegalStateException("No open session for " + drawerId));
    BigDecimal expected =
        session.getOpeningCash().add(transactions.sumNetCash(drawerId, session.getBusinessDate()));
    BigDecimal variance = countedCash.subtract(expected);

    if (variance.abs().compareTo(tolerance) > 0) {
      log.warn(
          "Drawer out of balance branch={} drawer={} businessDate={} expected={} counted={} variance={}",
          session.getBranchId(), drawerId, session.getBusinessDate(), expected, countedCash, variance);
      return new BalanceResult(false, expected, countedCash, variance);
    }
    session.close(countedCash);
    return new BalanceResult(true, expected, countedCash, variance);
  }
}
`;

export const TLR_GL_CLIENT = `package com.keybank.tlr.client;

import com.keybank.tlr.domain.TellerTransaction;
import java.math.BigDecimal;
import java.time.LocalDate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;

/** Posts teller transactions to gl-posting-service (GLD). Rejections go to the EOD sweep queue. */
@Component
public class GlPostingClient {

  private static final Logger log = LoggerFactory.getLogger(GlPostingClient.class);

  private final RestClient http;
  private final JdbcTemplate jdbc;

  public GlPostingClient(
      RestClient.Builder builder, JdbcTemplate jdbc, @Value("\${teller.clients.gl-base-url}") String baseUrl) {
    this.http = builder.baseUrl(baseUrl).build();
    this.jdbc = jdbc;
  }

  record GlPostingRequest(
      String ledger, String journalId, String sourceSystem, LocalDate businessDate,
      String branchId, String accountNumber, BigDecimal amount) {}

  public void post(TellerTransaction tx) {
    GlPostingRequest request =
        new GlPostingRequest(
            "PRIMARY", tx.getId(), "TLR", tx.getBusinessDate(), tx.getBranchId(),
            tx.getAccountNumber(), tx.getAmount());
    try {
      http.post().uri("/v1/postings").body(request).retrieve().toBodilessEntity();
    } catch (HttpClientErrorException.UnprocessableEntity ex) {
      log.warn(
          "GL posting rejected for txn {} (422): {}; queued for EOD sweep",
          tx.getId(),
          ex.getResponseBodyAsString());
      jdbc.update("insert into gl_retry_queue (txn_id, queued_at) values (?, now())", tx.getId());
    }
  }
}
`;

export const TLR_PROFILE_CLIENT = `package com.keybank.tlr.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** CIF lookups for customer identification at the teller window. */
@Component
public class CustomerProfileClient {

  public record CustomerProfile(
      String customerId, String firstName, String lastName, String kycStatus, String segment) {}

  private final RestClient http;

  public CustomerProfileClient(
      RestClient.Builder builder, @Value("\${teller.clients.cif-base-url}") String baseUrl) {
    this.http = builder.baseUrl(baseUrl).build();
  }

  /** Fetches the profile and checks CIF answered for the customer we asked about. */
  public CustomerProfile getVerifiedProfile(String customerId) {
    CustomerProfile profile =
        http.get().uri("/v1/customers/{id}/profile", customerId).retrieve().body(CustomerProfile.class);
    if (profile == null || !customerId.equals(profile.customerId())) {
      throw new IllegalStateException(
          "CIF returned profile for " + (profile == null ? "nothing" : profile.customerId())
              + " when asked for " + customerId);
    }
    return profile;
  }
}
`;

export const TLR_CONTROLLER = `package com.keybank.tlr.api;

import com.keybank.tlr.client.CustomerProfileClient;
import com.keybank.tlr.client.CustomerProfileClient.CustomerProfile;
import com.keybank.tlr.domain.TellerTransaction;
import com.keybank.tlr.service.DrawerBalancingService;
import com.keybank.tlr.service.DrawerBalancingService.BalanceResult;
import com.keybank.tlr.service.TellerTransactionService;
import com.keybank.tlr.service.TellerTransactionService.PostTransactionCommand;
import java.math.BigDecimal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Backend for the Teller Workstation desktop app. */
@RestController
@RequestMapping("/v1/teller")
public class TellerController {

  private final TellerTransactionService transactions;
  private final DrawerBalancingService balancing;
  private final CustomerProfileClient customers;

  public TellerController(
      TellerTransactionService transactions,
      DrawerBalancingService balancing,
      CustomerProfileClient customers) {
    this.transactions = transactions;
    this.balancing = balancing;
    this.customers = customers;
  }

  @GetMapping("/customers/{customerId}")
  public CustomerProfile lookupCustomer(@PathVariable String customerId) {
    return customers.getVerifiedProfile(customerId);
  }

  @PostMapping("/transactions")
  public TellerTransaction post(@RequestBody PostTransactionCommand command) {
    return transactions.post(command);
  }

  public record BalanceRequest(BigDecimal countedCash) {}

  @PostMapping("/drawers/{drawerId}/balance")
  public BalanceResult balance(@PathVariable String drawerId, @RequestBody BalanceRequest request) {
    return balancing.balance(drawerId, request.countedCash());
  }
}
`;

export const TLR_BUSINESS_DATE_TEST = `package com.keybank.tlr.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.keybank.tlr.config.BusinessDayProperties;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Set;
import org.junit.jupiter.api.Test;

class BusinessDateServiceTest {

  private static BusinessDateService at(String instant) {
    BusinessDayProperties props = new BusinessDayProperties();
    props.setTimezone("America/New_York");
    props.setHolidays(Set.of(LocalDate.parse("2026-11-11")));
    return new BusinessDateService(Clock.fixed(Instant.parse(instant), ZoneOffset.UTC), props);
  }

  @Test
  void afternoonPostsToToday() {
    // 3:30 PM Eastern (EST, UTC-5)
    assertThat(at("2026-11-09T20:30:00Z").currentBusinessDate()).isEqualTo(LocalDate.parse("2026-11-09"));
  }

  @Test
  void afterCutoffPostsToNextBusinessDay() {
    // 7:15 PM Eastern
    assertThat(at("2026-11-10T00:15:00Z").currentBusinessDate()).isEqualTo(LocalDate.parse("2026-11-10"));
  }

  @Test
  void skipsHolidays() {
    // 7:30 PM Eastern on Tuesday 11/10; 11/11 is Veterans Day
    assertThat(at("2026-11-11T00:30:00Z").currentBusinessDate()).isEqualTo(LocalDate.parse("2026-11-12"));
  }

  @Test
  void saturdayPostsToMonday() {
    assertThat(at("2026-11-14T15:00:00Z").currentBusinessDate()).isEqualTo(LocalDate.parse("2026-11-16"));
  }
}
`;

export const TLR_TRANSACTION_SERVICE_TEST = `package com.keybank.tlr.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.keybank.tlr.client.GlPostingClient;
import com.keybank.tlr.domain.DrawerSession;
import com.keybank.tlr.domain.DrawerSessionRepository;
import com.keybank.tlr.domain.TellerTransaction;
import com.keybank.tlr.domain.TellerTransactionRepository;
import com.keybank.tlr.service.TellerTransactionService.PostTransactionCommand;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class TellerTransactionServiceTest {

  private final Clock clock = Clock.fixed(Instant.parse("2026-11-09T16:00:00Z"), ZoneOffset.UTC);
  private final BusinessDateService businessDates = mock(BusinessDateService.class);
  private final DrawerSessionRepository sessions = mock(DrawerSessionRepository.class);
  private final TellerTransactionRepository transactions = mock(TellerTransactionRepository.class);
  private final GlPostingClient gl = mock(GlPostingClient.class);
  private final TellerTransactionService service =
      new TellerTransactionService(clock, businessDates, sessions, transactions, gl);

  @Test
  void postsCashDepositToCurrentBusinessDate() {
    DrawerSession session = mock(DrawerSession.class);
    when(session.getBranchId()).thenReturn("0101");
    when(session.getDrawerId()).thenReturn("D-07");
    when(session.getBusinessDate()).thenReturn(LocalDate.parse("2026-11-09"));
    when(sessions.findOpen("D-07")).thenReturn(Optional.of(session));
    when(businessDates.currentBusinessDate()).thenReturn(LocalDate.parse("2026-11-09"));

    TellerTransaction tx =
        service.post(
            new PostTransactionCommand(
                "D-07", "CASH_DEPOSIT", "****4821", new BigDecimal("250.00"),
                new BigDecimal("250.00"), BigDecimal.ZERO));

    assertThat(tx.getBusinessDate()).isEqualTo(LocalDate.parse("2026-11-09"));
    assertThat(tx.getPostedAt()).isEqualTo(LocalDateTime.parse("2026-11-09T16:00:00"));
    verify(gl).post(any());
  }
}
`;

const TRANSACTION_SERVICE_TEST_BAD = TLR_TRANSACTION_SERVICE_TEST.replace(
  'import java.time.LocalDate;\nimport java.time.LocalDateTime;\n',
  'import java.time.LocalDate;\n',
).replace(
  'assertThat(tx.getPostedAt()).isEqualTo(LocalDateTime.parse("2026-11-09T16:00:00"));',
  'assertThat(tx.getPostedAt()).isEqualTo(Instant.parse("2026-11-09T16:00:00Z"));',
);

/** Full contents of the files the UTC MR rewrites (besides application.yml). */
export const TLR_BAD_CONTENT = {
  transaction: TRANSACTION_BAD,
  transactionService: TRANSACTION_SERVICE_BAD,
  transactionServiceTest: TRANSACTION_SERVICE_TEST_BAD,
};

const MIGRATION = `create table drawer_session (
  id             varchar(40)   primary key,
  branch_id      varchar(4)    not null,
  drawer_id      varchar(8)    not null,
  teller_id      varchar(20)   not null,
  business_date  date          not null,
  opening_cash   numeric(12,2) not null,
  closing_cash   numeric(12,2),
  status         varchar(10)   not null default 'OPEN'
);

create table teller_transaction (
  id              varchar(40)   primary key,
  branch_id       varchar(4)    not null,
  drawer_id       varchar(8)    not null,
  teller_id       varchar(20)   not null,
  type            varchar(20)   not null,
  account_number  varchar(17),
  amount          numeric(12,2) not null,
  cash_in         numeric(12,2) not null default 0,
  cash_out        numeric(12,2) not null default 0,
  business_date   date          not null,
  posted_at       timestamp     not null
);

create index teller_transaction_drawer_date_idx on teller_transaction (drawer_id, business_date);

create table gl_retry_queue (
  txn_id     varchar(40) primary key,
  queued_at  timestamptz not null
);
`;

export const tlrOverlay: RepoOverlay = {
  complete: true,
  files: {
    'pom.xml': springPom({
      tla: 'TLR',
      artifactId: 'teller-workstation-api',
      version: '7.3.0',
      description: 'Teller transactions, drawers and end-of-day balancing',
      extraDependencies: [
        `    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-jdbc</artifactId>
    </dependency>`,
      ],
    }),
    [TLR_PATHS.applicationYml]: TLR_APPLICATION_YML,
    [`${PKG}/TellerWorkstationApplication.java`]: APPLICATION,
    [TLR_PATHS.properties]: TLR_PROPERTIES,
    [TLR_PATHS.businessDateService]: TLR_BUSINESS_DATE_SERVICE,
    [TLR_PATHS.transaction]: TRANSACTION,
    [`${PKG}/domain/TellerTransactionRepository.java`]: TRANSACTION_REPOSITORY,
    [`${PKG}/domain/DrawerSession.java`]: DRAWER_SESSION,
    [`${PKG}/domain/DrawerSessionRepository.java`]: DRAWER_SESSION_REPOSITORY,
    [TLR_PATHS.transactionService]: TLR_TRANSACTION_SERVICE,
    [TLR_PATHS.drawerBalancing]: TLR_DRAWER_BALANCING,
    [TLR_PATHS.glClient]: TLR_GL_CLIENT,
    [TLR_PATHS.profileClient]: TLR_PROFILE_CLIENT,
    [TLR_PATHS.controller]: TLR_CONTROLLER,
    'src/main/resources/db/migration/V1__teller.sql': MIGRATION,
    [TLR_PATHS.businessDateTest]: TLR_BUSINESS_DATE_TEST,
    [TLR_PATHS.transactionServiceTest]: TLR_TRANSACTION_SERVICE_TEST,
  },
};
