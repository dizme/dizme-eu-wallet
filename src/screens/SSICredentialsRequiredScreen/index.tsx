import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {PEX, SelectResults, SubmissionRequirementMatch} from '@sphereon/pex';
import {Status} from '@sphereon/pex/dist/main/lib/ConstraintUtils';
import {InputDescriptorV1, InputDescriptorV2} from '@sphereon/pex-models';
import {ICredentialBranding} from '@sphereon/ssi-sdk.data-store';
import {CredentialMapper, OriginalVerifiableCredential} from '@sphereon/ssi-types';
import {UniqueVerifiableCredential} from '@veramo/core';
import React, {FC, useEffect, useState} from 'react';
import {ListRenderItemInfo} from 'react-native';
import {SwipeListView} from 'react-native-swipe-list-view';

import {OVERVIEW_INITIAL_NUMBER_TO_RENDER} from '../../@config/constants';
import {ibGetCredentialBranding} from '../../agent';
import SSIButtonsContainer from '../../components/containers/SSIButtonsContainer';
import SSICredentialRequiredViewItem from '../../components/views/SSICredentialRequiredViewItem';
import {translate} from '../../localization/Localization';
import {getVerifiableCredentialsFromStorage} from '../../services/credentialService';
import {
  SSICredentialsRequiredScreenButtonContainerStyled as ButtonContainer,
  SSIBasicContainerStyled as Container,
  SSIStatusBarDarkModeStyled as StatusBar,
} from '../../styles/components';
import {ScreenRoutesEnum, StackParamList} from '../../types';
import {getMatchingUniqueVerifiableCredential, getOriginalVerifiableCredential} from '../../utils/CredentialUtils';
import {toCredentialSummary} from '../../utils/mappers/credential/CredentialMapper';
import {JSONPath} from '@astronautlabs/jsonpath';

type Props = NativeStackScreenProps<StackParamList, ScreenRoutesEnum.CREDENTIALS_REQUIRED>;

const SSICredentialsRequiredScreen: FC<Props> = (props: Props): JSX.Element => {
  const {presentationDefinition, format, subjectSyntaxTypesSupported, verifier} = props.route.params;
  const [selectedCredentials, setSelectedCredentials] = useState(new Map<string, Array<UniqueVerifiableCredential>>());
  const [availableCredentials, setAvailableCredentials] = useState(new Map<string, Array<UniqueVerifiableCredential>>());
  const pex = new PEX();

  useEffect(() => {
    // TODO we need to have one source for these credentials as then all the data is always available
    getVerifiableCredentialsFromStorage().then((uniqueVCs: Array<UniqueVerifiableCredential>) => {
      // We need to go to a wrapped VC first to get an actual original Verifiable Credential in JWT format, as they are stored with a special Proof value in Veramo
      const originalVcs: Array<OriginalVerifiableCredential> = uniqueVCs.map(
        (uniqueVC: UniqueVerifiableCredential) =>
          CredentialMapper.toWrappedVerifiableCredential(uniqueVC.verifiableCredential as OriginalVerifiableCredential).original,
      );
      const availableVCs = new Map<string, Array<UniqueVerifiableCredential>>();
      presentationDefinition.input_descriptors.forEach((inputDescriptor: InputDescriptorV1 | InputDescriptorV2) => {
        const presentationDefinition = {
          id: inputDescriptor.id,
          input_descriptors: [inputDescriptor],
        };
        const selectResult: SelectResults = pex.selectFrom(presentationDefinition, originalVcs, {
          restrictToFormats: format,
          restrictToDIDMethods: subjectSyntaxTypesSupported,
        });
        if (selectResult.areRequiredCredentialsPresent === Status.ERROR) {
          console.debug('pex.selectFrom returned errors:\n', JSON.stringify(selectResult.errors));
        }
        const matchedVCs: Array<UniqueVerifiableCredential> =
          selectResult.matches && selectResult.verifiableCredential
            ? selectResult.matches
                .map((match: SubmissionRequirementMatch) => {
                  const matchedVC = JSONPath.query(selectResult, match.vc_path[0]); // TODO Can we have multiple vc_path elements for a single match?
                  if (matchedVC && matchedVC.length > 0) {
                    return getMatchingUniqueVerifiableCredential(uniqueVCs, matchedVC[0]);
                  }
                })
                .filter((matchedVC: UniqueVerifiableCredential | undefined): matchedVC is UniqueVerifiableCredential => !!matchedVC) // filter out the undefined (should not happen)
            : [];
        availableVCs.set(inputDescriptor.id, matchedVCs);
      });
      setAvailableCredentials(availableVCs);
    });
  }, []);

  useEffect(() => {
    const selectedVCs = new Map<string, Array<UniqueVerifiableCredential>>();
    presentationDefinition.input_descriptors.forEach((inputDescriptor: InputDescriptorV1 | InputDescriptorV2) =>
      selectedVCs.set(inputDescriptor.id, []),
    );
    setSelectedCredentials(selectedVCs);
  }, [presentationDefinition]);

  const onDecline = async (): Promise<void> => {
    props.navigation.goBack();
  };

  const onSend = async (): Promise<void> => {
    const {onSend} = props.route.params;
    const selectedVCs = getSelectedCredentials();

    await onSend(selectedVCs.map(uniqueVC => getOriginalVerifiableCredential(uniqueVC.verifiableCredential)));
  };

  const getSelectedCredentials = (): Array<UniqueVerifiableCredential> => {
    const selectedVCs: Array<Array<UniqueVerifiableCredential>> = [];
    for (const uniqueVCs of selectedCredentials.values()) {
      selectedVCs.push(uniqueVCs);
    }

    return selectedVCs.flat();
  };

  const isMatchingPresentationDefinition = (): boolean => {
    return (
      pex.evaluateCredentials(
        presentationDefinition,
        getSelectedCredentials().map(uniqueVC => getOriginalVerifiableCredential(uniqueVC.verifiableCredential)),
      ).areRequiredCredentialsPresent === Status.INFO
    );
  };

  const onItemPress = async (inputDescriptorId: string, uniqueVCs: Array<UniqueVerifiableCredential>, inputDescriptorPurpose?: string) => {
    // TODO we need to have one source for these credentials as then all the data is always available
    const vcHashes: Array<{vcHash: string}> = uniqueVCs.map((uniqueCredential: UniqueVerifiableCredential): {vcHash: string} => ({
      vcHash: uniqueCredential.hash,
    }));
    const credentialsBranding: Array<ICredentialBranding> = await ibGetCredentialBranding({filter: vcHashes});

    props.navigation.navigate(ScreenRoutesEnum.CREDENTIALS_SELECT, {
      credentialSelection: await Promise.all(
        uniqueVCs.map(async (uniqueVC: UniqueVerifiableCredential) => {
          // TODO we need to have one source for these credentials as then all the data is always available
          const credentialBranding: ICredentialBranding | undefined = credentialsBranding.find(
            (branding: ICredentialBranding) => branding.vcHash === uniqueVC.hash,
          );
          const credentialSummary = await toCredentialSummary(uniqueVC, credentialBranding?.localeBranding);
          const rawCredential = await getOriginalVerifiableCredential(uniqueVC.verifiableCredential);
          const isSelected = selectedCredentials
            .get(inputDescriptorId)!
            .some(
              matchedVC =>
                matchedVC.verifiableCredential.id === uniqueVC.verifiableCredential.id ||
                matchedVC.verifiableCredential.proof === uniqueVC.verifiableCredential.proof,
            );
          return {
            hash: credentialSummary.hash,
            id: credentialSummary.id,
            credential: credentialSummary,
            rawCredential: rawCredential,
            isSelected: isSelected,
          };
        }),
      ),
      purpose: inputDescriptorPurpose,
      // TODO move this to a function, would be nicer
      onSelect: async (hashes: Array<string>) => {
        const selectedVCs = availableCredentials.get(inputDescriptorId)!.filter(vc => hashes.includes(vc.hash));
        selectedCredentials.set(inputDescriptorId, selectedVCs);
        const newSelection = new Map<string, Array<UniqueVerifiableCredential>>();
        for (const [key, value] of selectedCredentials) {
          newSelection.set(key, value);
        }
        setSelectedCredentials(newSelection);
      },
    });
  };

  // TODO add support for multiple versions of pex, currently using V1
  const renderItem = (itemInfo: ListRenderItemInfo<InputDescriptorV1 | InputDescriptorV2>): JSX.Element => {
    const onPress =
      !availableCredentials.has(itemInfo.item.id) || availableCredentials.get(itemInfo.item.id)!.length === 0
        ? undefined
        : () => onItemPress(itemInfo.item.id, availableCredentials.get(itemInfo.item.id)!, itemInfo.item.purpose);

    const checkIsMatching = (
      itemInfo: ListRenderItemInfo<InputDescriptorV1 | InputDescriptorV2>,
      selectedCredentials: Map<string, Array<UniqueVerifiableCredential>>,
    ): boolean => {
      if (!selectedCredentials.has(itemInfo.item.id)) {
        return false;
      }
      const selectedCredential: Array<UniqueVerifiableCredential> | undefined = selectedCredentials.get(itemInfo.item.id);
      if (!selectedCredential) {
        return false;
      }

      const credentials: Array<OriginalVerifiableCredential> = selectedCredential.map((uniqueVC: UniqueVerifiableCredential) =>
        getOriginalVerifiableCredential(uniqueVC.verifiableCredential),
      );
      return (
        pex.evaluateCredentials(
          {
            id: itemInfo.item.id,
            input_descriptors: [itemInfo.item],
          },
          credentials,
        ).areRequiredCredentialsPresent === Status.INFO
      );
    };

    return (
      <SSICredentialRequiredViewItem
        id={itemInfo.item.id}
        title={itemInfo.item.name || itemInfo.item.id}
        purpose={itemInfo.item.purpose}
        available={availableCredentials.has(itemInfo.item.id) ? availableCredentials.get(itemInfo.item.id)! : undefined}
        selected={selectedCredentials.has(itemInfo.item.id) ? selectedCredentials.get(itemInfo.item.id)! : []}
        isMatching={checkIsMatching(itemInfo, selectedCredentials)}
        listIndex={itemInfo.index}
        onPress={onPress}
      />
    );
  };

  return (
    <Container>
      <StatusBar />
      <SwipeListView
        data={presentationDefinition.input_descriptors}
        keyExtractor={(itemInfo: InputDescriptorV1 | InputDescriptorV2) => itemInfo.id}
        renderItem={renderItem}
        closeOnRowOpen
        closeOnRowBeginSwipe
        useFlatList
        initialNumToRender={OVERVIEW_INITIAL_NUMBER_TO_RENDER}
        removeClippedSubviews
      />
      <ButtonContainer>
        <SSIButtonsContainer
          secondaryButton={{
            caption: translate('action_decline_label'),
            onPress: onDecline,
          }}
          primaryButton={{
            caption: translate('action_share_label'),
            disabled: !isMatchingPresentationDefinition(),
            onPress: onSend,
          }}
        />
      </ButtonContainer>
    </Container>
  );
};

export default SSICredentialsRequiredScreen;
