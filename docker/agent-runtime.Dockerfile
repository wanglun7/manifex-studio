FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_BREAK_SYSTEM_PACKAGES=1

RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g; s|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    fd-find \
    file \
    git \
    jq \
    less \
    openssh-client \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    tini \
    unzip \
    wget \
    zip \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir \
    beautifulsoup4 \
    markdownify \
    openpyxl \
    pandas \
    pdfplumber \
    pypdf \
    python-docx \
    requests

RUN npm install -g @larksuite/cli@latest

WORKDIR /workspace

ENTRYPOINT ["tini", "--"]
CMD ["sleep", "infinity"]
